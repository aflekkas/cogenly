/**
 * The hub side of the machine link: the spokes paired to this server, their
 * open `/peer` sockets, and requests sent down those sockets. Spokes always
 * dial the hub, so nothing here opens a connection; a spoke that is not
 * connected is offline and requests to it are refused, never queued.
 */
import {
  type AuthClientMetadata,
  type AuthSessionId,
  EnvironmentId,
  MachineError,
  type MachineInfo,
  MachineSelfReport,
  PeerCallError,
  type PeerCallInput,
  type PeerChannel,
  type PeerHelloInput,
  type PeerChallengeResult,
  type PeerJoinRequest,
  PEER_PROTOCOL_VERSION,
  type PeerIdentityRequest,
  type PeerHelloResult,
  type PeerJoinResult,
  PeerProtocolError,
  type PeerPush,
  type PeerReplyInput,
  isAuthPeerScope,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { readHubLink } from "./hubLinkStore.ts";
import * as MachineIdentity from "./MachineIdentity.ts";
import { toMachineInfo } from "./machineInfo.ts";
import * as PeerChannels from "./PeerChannels.ts";
import { decodePeerResult, encodePeerPayload } from "./PeerChannels.ts";
import {
  signPeerTranscript,
  verifyPeerProof,
  hubPublicKey,
  peerDigest,
  peerIdentityTranscript,
  peerJoinProofTranscript,
  peerJoinTranscript,
  peerHelloProofTranscript,
  peerHelloTranscript,
  createPeerEphemeral,
  derivePeerSessionKey,
} from "./peerCrypto.ts";
import { PeerFrameCodec } from "./peerFrames.ts";

export class PeerJoinRefusedError extends Schema.TaggedError<PeerJoinRefusedError>()(
  "PeerJoinRefusedError",
  {
    reason: Schema.Literals(["hub-is-spoke", "grant-rejected"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "hub-is-spoke"
      ? "This machine joined a hub, so other machines cannot pair to it."
      : "The pairing grant was refused.";
  }
}

/** The handlers of one open `/peer` socket, served by peerHttp.ts. */
export interface PeerHubConnection {
  readonly frames: PeerFrameCodec;
  readonly challenge: (input: {
    readonly version: number;
  }) => Effect.Effect<PeerChallengeResult, PeerProtocolError>;
  readonly hello: (input: PeerHelloInput) => Effect.Effect<PeerHelloResult, PeerProtocolError>;
  readonly ping: (input: {
    readonly spoke?: MachineSelfReport;
  }) => Effect.Effect<{}, PeerProtocolError>;
  readonly machines: Effect.Effect<ReadonlyArray<MachineInfo>, PeerProtocolError>;
  readonly inbox: Stream.Stream<PeerPush, PeerProtocolError>;
  readonly reply: (input: PeerReplyInput) => Effect.Effect<{}, PeerProtocolError>;
  readonly call: (
    input: PeerCallInput,
  ) => Effect.Effect<Schema.Json, PeerCallError | PeerProtocolError>;
  readonly leave: Effect.Effect<{}, PeerProtocolError>;
  /**
   * Completes when the hub drops this socket (unpaired, or replaced by a newer
   * one) and the inbox has delivered what was queued, such as `Unpaired`.
   */
  readonly closed: Effect.Effect<void>;
  /** The session was revoked elsewhere: unpair, tell the spoke, then close. */
  readonly revoked: Effect.Effect<void>;
}

export class PeerHub extends Context.Service<
  PeerHub,
  {
    /** Prove the hub pin before a spoke sends any credential. */
    readonly proveIdentity: (input: PeerIdentityRequest) => Effect.Effect<
      {
        readonly hubEnvironmentId: EnvironmentId;
        readonly signature: string;
      },
      MachineError
    >;
    /** Spend a peer grant presented by a spoke whose proof key was verified. */
    readonly redeem: (input: {
      readonly proofKey: PeerJoinRequest["proofKey"];
      readonly proof: string;
      readonly grant: string;
      readonly nonce: string;
      readonly proofKeyThumbprint: string;
      readonly spoke: MachineSelfReport;
      readonly client: AuthClientMetadata;
    }) => Effect.Effect<PeerJoinResult, PeerJoinRefusedError | MachineError>;
    /** A one-time socket ticket for a paired spoke's session. */
    readonly issueTicket: (
      session: EnvironmentAuth.PeerSession,
    ) => Effect.Effect<
      { readonly ticket: string },
      PeerProtocolError | EnvironmentAuth.ServerAuthInternalError
    >;
    /** Serve one `/peer` socket until the surrounding scope closes. */
    readonly connect: (
      session: EnvironmentAuth.PeerSession,
    ) => Effect.Effect<PeerHubConnection, never, Scope.Scope>;
    /** Paired spokes, from this hub's point of view. */
    readonly spokes: Effect.Effect<ReadonlyArray<MachineInfo>, MachineError>;
    readonly unpair: (environmentId: EnvironmentId) => Effect.Effect<boolean, MachineError>;
    /** Ask a connected spoke to run a channel request. Refused when it is offline. */
    readonly callSpoke: <C extends PeerChannel>(
      environmentId: EnvironmentId,
      channel: C,
      payload: C["payload"]["Type"],
    ) => Effect.Effect<C["success"]["Type"], PeerCallError>;
    /** Emits whenever a spoke pairs, unpairs, connects, disconnects or reports. */
    readonly changes: Stream.Stream<void>;
  }
>()("cogenly-server/machines/PeerHub") {}

interface SpokeRow {
  readonly environmentId: EnvironmentId;
  readonly sessionId: AuthSessionId;
  readonly report: MachineSelfReport;
  readonly pairedAt: DateTime.Utc;
  readonly lastSeenAt: DateTime.Utc | null;
}

interface LiveConnection {
  readonly id: number;
  readonly environmentId: EnvironmentId;
  readonly outbox: Queue.Queue<PeerPush, Cause.Done>;
  readonly pending: Map<string, Deferred.Deferred<Schema.Json, PeerCallError>>;
  readonly closed: Deferred.Deferred<void>;
}

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(MachineSelfReport));
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(MachineSelfReport));

const parseTime = (value: string | null) =>
  value === null ? null : Option.getOrNull(DateTime.make(value).pipe(Option.map(DateTime.toUtc)));

const storage = (operation: MachineError["operation"]) => (cause: unknown) =>
  new MachineError({ operation, reason: "storage", cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessions = yield* SessionStore.SessionStore;
  const identity = yield* MachineIdentity.MachineIdentity;
  const channels = yield* PeerChannels.PeerChannels;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const changed = yield* PubSub.unbounded<void>();
  const live = new Map<EnvironmentId, LiveConnection>();
  let nextConnectionId = 0;

  const withSecrets = <A, E>(effect: Effect.Effect<A, E, ServerSecretStore.ServerSecretStore>) =>
    Effect.provideService(effect, ServerSecretStore.ServerSecretStore, secrets);

  const proveIdentity: PeerHub["Service"]["proveIdentity"] = (input) =>
    Effect.gen(function* () {
      const self = yield* identity.self;
      const signature = yield* withSecrets(
        signPeerTranscript(
          peerIdentityTranscript({
            hubEnvironmentId: self.environmentId,
            spokeEnvironmentId: input.spokeEnvironmentId,
            nonce: input.nonce,
          }),
        ),
      ).pipe(Effect.mapError(storage("join")));
      return { hubEnvironmentId: self.environmentId, signature };
    });

  const readRows = Effect.gen(function* () {
    const rows = yield* sql<{
      readonly environment_id: string;
      readonly session_id: string;
      readonly report_json: string;
      readonly paired_at: string;
      readonly last_seen_at: string | null;
    }>`SELECT environment_id, session_id, report_json, paired_at, last_seen_at FROM machine_peers ORDER BY paired_at`;
    return yield* Effect.forEach(rows, (row) =>
      decodeReport(row.report_json).pipe(
        Effect.map((report): SpokeRow => ({
          environmentId: EnvironmentId.make(row.environment_id),
          sessionId: row.session_id as AuthSessionId,
          report,
          pairedAt: parseTime(row.paired_at) ?? DateTime.makeUnsafe(0),
          lastSeenAt: parseTime(row.last_seen_at),
        })),
      ),
    );
  });

  const rowForSession = (sessionId: AuthSessionId) =>
    readRows.pipe(
      Effect.map((rows) => rows.find((row) => row.sessionId === sessionId)),
      Effect.orElseSucceed(() => undefined),
    );

  const touch = (environmentId: EnvironmentId, report?: MachineSelfReport) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      if (report === undefined) {
        yield* sql`UPDATE machine_peers SET last_seen_at = ${now} WHERE environment_id = ${environmentId}`;
      } else {
        const encoded = yield* encodeReport(report);
        yield* sql`UPDATE machine_peers SET last_seen_at = ${now}, report_json = ${encoded} WHERE environment_id = ${environmentId}`;
      }
    }).pipe(Effect.ignore({ log: true }));

  const spokes: PeerHub["Service"]["spokes"] = Effect.gen(function* () {
    const rows = yield* readRows.pipe(Effect.mapError(storage("list")));
    const active = yield* sessions.listActive().pipe(Effect.mapError(storage("list")));
    const activeIds = new Set(active.map((session) => session.sessionId));
    return rows.map((row) =>
      toMachineInfo(row.report, {
        relation: "spoke",
        online: live.has(row.environmentId),
        lastSeenAt: row.lastSeenAt,
        pairedAt: row.pairedAt,
        pairing: activeIds.has(row.sessionId) ? "paired" : "revoked",
      }),
    );
  }).pipe(Effect.withSpan("PeerHub.spokes"));

  /** What every spoke sees: this hub plus all of its spokes. */
  const hubView = Effect.gen(function* () {
    const self = yield* identity.self;
    return [
      toMachineInfo(self, {
        relation: "this",
        online: true,
        lastSeenAt: null,
        pairedAt: null,
        pairing: "self",
      }),
      ...(yield* spokes),
    ];
  });

  // Every change also goes down every open socket, so spokes list each other.
  const publishChange = Effect.gen(function* () {
    yield* PubSub.publish(changed, undefined);
    if (live.size === 0) return;
    const machines = yield* hubView.pipe(Effect.option);
    if (Option.isNone(machines)) return;
    for (const connection of live.values()) {
      Queue.offerUnsafe(connection.outbox, { _tag: "Machines", machines: machines.value });
    }
  });

  // Stops serving a socket: its pending calls fail, its inbox ends and the
  // route closes it. Only the newest socket of a spoke counts as online.
  // How long a dropped socket may take to deliver its last pushes.
  const DRAIN_TIMEOUT = Duration.seconds(5);

  const drop = (connection: LiveConnection) =>
    Effect.gen(function* () {
      for (const pending of connection.pending.values()) {
        yield* Deferred.fail(pending, new PeerCallError({ channel: "", reason: "disconnected" }));
      }
      yield* Queue.end(connection.outbox);
      yield* Deferred.succeed(connection.closed, undefined);
      if (live.get(connection.environmentId)?.id === connection.id) {
        live.delete(connection.environmentId);
        return true;
      }
      return false;
    });

  // This hub's own name or kind changed: spokes list it too.
  yield* identity.changes.pipe(
    Stream.runForEach(() => publishChange),
    Effect.forkScoped,
  );

  const redeem: PeerHub["Service"]["redeem"] = Effect.fn("PeerHub.redeem")(function* (input) {
    const joinedHub = yield* withSecrets(readHubLink).pipe(Effect.mapError(storage("join")));
    if (Option.isSome(joinedHub)) {
      return yield* new PeerJoinRefusedError({ reason: "hub-is-spoke" });
    }
    const self = yield* identity.self;
    if (input.spoke.environmentId === self.environmentId) {
      return yield* new PeerJoinRefusedError({ reason: "grant-rejected" });
    }
    const publicKey = yield* withSecrets(hubPublicKey).pipe(Effect.mapError(storage("join")));
    if (
      !verifyPeerProof(
        input.proofKey,
        input.proofKeyThumbprint,
        peerJoinProofTranscript({
          hubPublicKey: publicKey,
          hubEnvironmentId: self.environmentId,
          spokeKeyThumbprint: input.proofKeyThumbprint,
          spoke: input.spoke,
          nonce: input.nonce,
          grantHash: peerDigest(input.grant),
        }),
        input.proof,
      )
    )
      return yield* new PeerJoinRefusedError({ reason: "grant-rejected" });
    const issued = yield* auth
      .redeemPeerGrant({
        credential: input.grant,
        proofKeyThumbprint: input.proofKeyThumbprint,
        client: { ...input.client, label: input.spoke.name },
      })
      .pipe(
        Effect.catchTags({
          ServerAuthInvalidCredentialError: (cause) =>
            Effect.fail(new PeerJoinRefusedError({ reason: "grant-rejected", cause })),
        }),
        Effect.mapError((cause) =>
          cause._tag === "PeerJoinRefusedError" ? cause : storage("join")(cause),
        ),
      );
    const existing = yield* readRows.pipe(
      Effect.map((rows) => rows.find((row) => row.environmentId === input.spoke.environmentId)),
      Effect.mapError(storage("join")),
    );
    // Re-pairing the same machine replaces its old credential and socket.
    if (existing !== undefined) {
      const connection = live.get(existing.environmentId);
      if (connection !== undefined) yield* drop(connection);
      yield* auth.revokeSession(existing.sessionId).pipe(Effect.mapError(storage("join")));
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const report = yield* encodeReport(input.spoke).pipe(Effect.mapError(storage("join")));
    yield* sql`INSERT INTO machine_peers (environment_id, session_id, report_json, paired_at, last_seen_at)
      VALUES (${input.spoke.environmentId}, ${issued.session.sessionId}, ${report}, ${now}, ${now})
      ON CONFLICT (environment_id) DO UPDATE SET
        session_id = excluded.session_id,
        report_json = excluded.report_json,
        paired_at = excluded.paired_at,
        last_seen_at = excluded.last_seen_at`.pipe(Effect.mapError(storage("join")));
    yield* publishChange;
    const grantedScopes = issued.session.scopes.filter(isAuthPeerScope);
    const signature = yield* withSecrets(
      signPeerTranscript(
        peerJoinTranscript({
          hubPublicKey: publicKey,
          hubEnvironmentId: self.environmentId,
          spokeKeyThumbprint: input.proofKeyThumbprint,
          spoke: input.spoke,
          nonce: input.nonce,
          grantHash: peerDigest(input.grant),
          accessTokenHash: peerDigest(issued.token),
          expiresAt: DateTime.formatIso(issued.expiresAt),
          scopes: grantedScopes,
          hub: self,
        }),
      ),
    ).pipe(Effect.mapError(storage("join")));
    return {
      accessToken: issued.token,
      expiresAt: issued.expiresAt,
      hubEnvironmentId: self.environmentId,
      scopes: grantedScopes,
      signature,
      hub: self,
    } satisfies PeerJoinResult;
  });

  const issueTicket: PeerHub["Service"]["issueTicket"] = Effect.fn("PeerHub.issueTicket")(
    function* (session) {
      const row = yield* rowForSession(session.sessionId);
      if (row === undefined) return yield* new PeerProtocolError({ reason: "not-paired" });
      const ticket = yield* auth.issueWebSocketTicket(session);
      return { ticket: ticket.ticket };
    },
  );

  const unpairRow = (row: SpokeRow) =>
    Effect.gen(function* () {
      const connection = live.get(row.environmentId);
      if (connection !== undefined) {
        // Tell the spoke before its socket closes, so it forgets the credential.
        yield* Queue.offer(connection.outbox, { _tag: "Unpaired" });
        yield* drop(connection);
      }
      yield* auth.revokeSession(row.sessionId).pipe(Effect.mapError(storage("unpair")));
      yield* sql`DELETE FROM machine_peers WHERE environment_id = ${row.environmentId}`.pipe(
        Effect.mapError(storage("unpair")),
      );
      yield* publishChange;
    });

  const unpair: PeerHub["Service"]["unpair"] = Effect.fn("PeerHub.unpair")(
    function* (environmentId) {
      const row = yield* readRows.pipe(
        Effect.map((rows) => rows.find((entry) => entry.environmentId === environmentId)),
        Effect.mapError(storage("unpair")),
      );
      if (row === undefined) return false;
      yield* unpairRow(row);
      return true;
    },
  );

  const callSpoke: PeerHub["Service"]["callSpoke"] = (environmentId, channel, payload) =>
    Effect.gen(function* () {
      const connection = live.get(environmentId);
      if (connection === undefined) {
        return yield* new PeerCallError({ channel: channel.name, reason: "offline" });
      }
      const encoded = yield* encodePeerPayload(channel, payload);
      const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const reply = yield* Deferred.make<Schema.Json, PeerCallError>();
      connection.pending.set(id, reply);
      yield* Queue.offer(connection.outbox, {
        _tag: "Request",
        id,
        channel: channel.name,
        payload: encoded,
      });
      const value = yield* Deferred.await(reply).pipe(
        Effect.mapError((error) =>
          error.channel === ""
            ? new PeerCallError({ channel: channel.name, reason: error.reason })
            : error,
        ),
        Effect.ensuring(Effect.sync(() => connection.pending.delete(id))),
      );
      return yield* decodePeerResult(channel, value);
    }).pipe(Effect.withSpan("PeerHub.callSpoke", { attributes: { channel: channel.name } }));

  const connect: PeerHub["Service"]["connect"] = (session) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const frames = new PeerFrameCodec("hub");
      const ephemeral = createPeerEphemeral();
      const challengeResult: PeerChallengeResult = {
        version: PEER_PROTOCOL_VERSION,
        connectionId: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
        hubEphemeralKey: ephemeral.publicKey,
      };
      let challenged = false;
      let helloStarted = false;
      const challenge: PeerHubConnection["challenge"] = (input) =>
        Effect.suspend(() => {
          if (input.version !== PEER_PROTOCOL_VERSION)
            return Effect.fail(new PeerProtocolError({ reason: "version-mismatch" }));
          if (challenged) return Effect.fail(new PeerProtocolError({ reason: "invalid-proof" }));
          challenged = true;
          return Effect.succeed(challengeResult);
        });
      const scopes = session.scopes.filter(isAuthPeerScope);
      const closed = yield* Deferred.make<void>();
      const inboxDone = yield* Deferred.make<void>();
      let inboxOpen = false;
      const heartbeat = yield* Queue.sliding<void>(1);
      let current: LiveConnection | undefined;
      // Every method but hello needs a hello on this socket, and only while
      // the socket is still the spoke's current one.
      const requireHello = Effect.suspend(() =>
        current === undefined
          ? Effect.fail(new PeerProtocolError({ reason: "hello-required" }))
          : live.get(current.environmentId)?.id === current.id
            ? Effect.succeed(current)
            : Effect.fail(new PeerProtocolError({ reason: "not-paired" })),
      );

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(closed, undefined);
          if (current === undefined) return;
          const wasLive = yield* drop(current);
          if (wasLive) {
            yield* touch(current.environmentId);
            yield* publishChange;
          }
        }),
      );

      const hello: PeerHubConnection["hello"] = (input) =>
        Effect.gen(function* () {
          const row = yield* rowForSession(session.sessionId);
          if (row === undefined) return yield* new PeerProtocolError({ reason: "not-paired" });
          // The credential is pinned to the machine that redeemed the grant.
          if (row.environmentId !== input.spoke.environmentId) {
            return yield* new PeerProtocolError({ reason: "machine-mismatch" });
          }
          if (input.version !== PEER_PROTOCOL_VERSION)
            return yield* new PeerProtocolError({ reason: "version-mismatch" });
          if (!challenged || helloStarted)
            return yield* new PeerProtocolError({ reason: "invalid-proof" });
          helloStarted = true;
          // A socket ticket selects the session; it is not proof of key possession.
          const credential = yield* sessions
            .verify(input.accessToken)
            .pipe(Effect.mapError(() => new PeerProtocolError({ reason: "invalid-proof" })));
          const self = yield* identity.self;
          const publicKey = yield* withSecrets(hubPublicKey).pipe(Effect.orDie);
          if (
            credential.sessionId !== session.sessionId ||
            credential.subject !== "peer" ||
            credential.method !== "dpop-access-token" ||
            credential.proofKeyThumbprint === undefined ||
            credential.expiresAt === undefined ||
            !verifyPeerProof(
              input.proofKey,
              credential.proofKeyThumbprint,
              peerHelloProofTranscript({
                hubPublicKey: publicKey,
                hubEnvironmentId: self.environmentId,
                spokeKeyThumbprint: credential.proofKeyThumbprint,
                spoke: input.spoke,
                nonce: input.nonce,
                accessTokenHash: peerDigest(input.accessToken),
                challenge: challengeResult,
                spokeEphemeralKey: input.spokeEphemeralKey,
              }),
              input.proof,
            )
          )
            return yield* new PeerProtocolError({ reason: "invalid-proof" });
          const expiresAt = DateTime.toUtc(credential.expiresAt);
          const helloTranscript = peerHelloTranscript({
            hubPublicKey: publicKey,
            hubEnvironmentId: self.environmentId,
            spokeKeyThumbprint: credential.proofKeyThumbprint,
            spoke: input.spoke,
            nonce: input.nonce,
            accessTokenHash: peerDigest(input.accessToken),
            challenge: challengeResult,
            spokeEphemeralKey: input.spokeEphemeralKey,
            scopes,
            expiresAt: DateTime.formatIso(expiresAt),
            hub: self,
          });
          const sessionKey = yield* Effect.try({
            try: () =>
              derivePeerSessionKey(ephemeral.privateKey, input.spokeEphemeralKey, helloTranscript),
            catch: () => new PeerProtocolError({ reason: "invalid-proof" }),
          });
          const signature = yield* withSecrets(signPeerTranscript(helloTranscript)).pipe(
            Effect.orDie,
          );
          frames.establish(challengeResult.connectionId, sessionKey);
          if (current === undefined) {
            const connection: LiveConnection = {
              id: nextConnectionId++,
              environmentId: row.environmentId,
              outbox: yield* Queue.unbounded<PeerPush, Cause.Done>(),
              pending: new Map(),
              closed,
            };
            // A spoke that reconnects before its old socket noticed the drop
            // replaces it; the old socket winds down.
            const replaced = live.get(row.environmentId);
            live.set(row.environmentId, connection);
            if (replaced !== undefined) yield* drop(replaced);
            current = connection;
            // A sleeping or vanished spoke may leave TCP open indefinitely.
            // Presence must expire even when no disconnect event arrives.
            yield* Effect.gen(function* () {
              while (
                Option.isSome(yield* Queue.take(heartbeat).pipe(Effect.timeoutOption("75 seconds")))
              ) {
                // Each verified heartbeat starts a fresh deadline.
              }
              yield* drop(connection);
              yield* publishChange;
            }).pipe(Effect.forkIn(scope));
          }
          yield* Queue.offer(heartbeat, undefined);
          yield* touch(row.environmentId, input.spoke);
          yield* publishChange;
          return { hubEnvironmentId: self.environmentId, signature, hub: self, scopes, expiresAt };
        }).pipe(Effect.withSpan("PeerHub.hello"));

      const ping: PeerHubConnection["ping"] = (input) =>
        requireHello.pipe(
          Effect.flatMap((connection) =>
            input.spoke !== undefined && input.spoke.environmentId !== connection.environmentId
              ? Effect.fail(new PeerProtocolError({ reason: "machine-mismatch" }))
              : Queue.offer(heartbeat, undefined).pipe(
                  Effect.andThen(touch(connection.environmentId, input.spoke)),
                  Effect.andThen(input.spoke === undefined ? Effect.void : publishChange),
                ),
          ),
          Effect.as({}),
        );

      const machines: PeerHubConnection["machines"] = requireHello.pipe(
        Effect.andThen(hubView.pipe(Effect.orElseSucceed(() => []))),
      );

      const inbox: PeerHubConnection["inbox"] = Stream.unwrap(
        requireHello.pipe(
          Effect.map((connection) => {
            inboxOpen = true;
            return Stream.fromQueue(connection.outbox).pipe(
              Stream.ensuring(Deferred.succeed(inboxDone, undefined)),
            );
          }),
        ),
      );

      const drained = Deferred.await(closed).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            inboxOpen
              ? Deferred.await(inboxDone).pipe(Effect.timeoutOption(DRAIN_TIMEOUT))
              : Effect.void,
          ),
        ),
        Effect.asVoid,
      );

      const revoked: PeerHubConnection["revoked"] = Effect.suspend(() =>
        current !== undefined && live.get(current.environmentId)?.id === current.id
          ? rowForSession(session.sessionId).pipe(
              Effect.flatMap((row) =>
                row === undefined
                  ? drop(current!)
                  : unpairRow(row).pipe(Effect.ignore({ log: true })),
              ),
            )
          : Deferred.succeed(closed, undefined),
      ).pipe(Effect.andThen(drained));

      const reply: PeerHubConnection["reply"] = (input) =>
        requireHello.pipe(
          Effect.flatMap((connection) => {
            const pending = connection.pending.get(input.id);
            if (pending === undefined) return Effect.void;
            return input.result._tag === "Success"
              ? Deferred.succeed(pending, input.result.value)
              : Deferred.fail(pending, input.result.error);
          }),
          Effect.as({}),
        );

      const call: PeerHubConnection["call"] = (input) =>
        requireHello.pipe(
          Effect.flatMap((connection) =>
            channels.dispatch({
              channel: input.channel,
              payload: input.payload,
              caller: { environmentId: connection.environmentId, scopes },
            }),
          ),
        );

      // The spoke unpairs itself: same cleanup as unpairing it from here.
      const leave: PeerHubConnection["leave"] = requireHello.pipe(
        Effect.andThen(rowForSession(session.sessionId)),
        Effect.flatMap((row) =>
          row === undefined ? Effect.void : unpairRow(row).pipe(Effect.ignore({ log: true })),
        ),
        Effect.as({}),
      );

      return {
        frames,
        challenge,
        hello,
        ping,
        machines,
        inbox,
        reply,
        call,
        leave,
        closed: drained,
        revoked,
      } satisfies PeerHubConnection;
    });

  return PeerHub.of({
    proveIdentity,
    redeem,
    issueTicket,
    connect,
    spokes,
    unpair,
    callSpoke,
    changes: Stream.fromPubSub(changed),
  });
});

export const layer = Layer.effect(PeerHub, make);

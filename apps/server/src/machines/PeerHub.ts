/**
 * The hub side of the machine link: the spokes paired to this server, their
 * open `/peer` sockets, and requests sent down those sockets. Spokes always
 * dial the hub, so nothing here opens a connection; a spoke that is not
 * connected is offline and requests to it are refused, never queued.
 */
import {
  type AuthClientMetadata,
  type AuthPeerScope,
  type AuthSessionId,
  AuthSyncReplicateScope,
  EnvironmentId,
  MachineError,
  type MachineInfo,
  MachineSelfReport,
  PeerCallError,
  type PeerCallInput,
  type PeerChannel,
  type PeerHelloInput,
  type PeerHelloResult,
  type PeerJoinResult,
  PeerProtocolError,
  type PeerPush,
  type PeerReplyInput,
  isAuthPeerScope,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
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
import { signPeerHello } from "./peerCrypto.ts";

export class PeerJoinRefusedError extends Schema.TaggedError<PeerJoinRefusedError>()(
  "PeerJoinRefusedError",
  { reason: Schema.Literals(["hub-is-spoke", "grant-rejected"]), cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason === "hub-is-spoke"
      ? "This machine joined a hub, so other machines cannot pair to it."
      : "The pairing grant was refused.";
  }
}

/** One open `/peer` socket, served by the RPC handlers in peerHttp.ts. */
export interface PeerHubConnection {
  readonly hello: (input: PeerHelloInput) => Effect.Effect<PeerHelloResult, PeerProtocolError>;
  readonly ping: (input: {
    readonly spoke?: MachineSelfReport;
  }) => Effect.Effect<{}, PeerProtocolError>;
  readonly machines: Effect.Effect<ReadonlyArray<MachineInfo>, PeerProtocolError>;
  readonly inbox: Stream.Stream<PeerPush, PeerProtocolError>;
  readonly reply: (input: PeerReplyInput) => Effect.Effect<{}, PeerProtocolError>;
  readonly call: (input: PeerCallInput) => Effect.Effect<Schema.Json, PeerCallError | PeerProtocolError>;
  readonly leave: Effect.Effect<{}, PeerProtocolError>;
}

export class PeerHub extends Context.Service<
  PeerHub,
  {
    /** Spend a peer grant presented by a spoke whose proof key was verified. */
    readonly redeem: (input: {
      readonly grant: string;
      readonly proofKeyThumbprint: string;
      readonly spoke: MachineSelfReport;
      readonly client: AuthClientMetadata;
    }) => Effect.Effect<PeerJoinResult, PeerJoinRefusedError | MachineError>;
    /** A one-time socket ticket for a paired spoke's session. */
    readonly issueTicket: (
      session: EnvironmentAuth.PeerSession,
    ) => Effect.Effect<
      { readonly ticket: string },
      PeerProtocolError | EnvironmentAuth.ServerAuthInternalError | MachineError
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
>()("t3/machines/PeerHub") {}

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
  readonly sessionId: AuthSessionId;
  readonly outbox: Queue.Queue<PeerPush, Cause.Done>;
  readonly pending: Map<string, Deferred.Deferred<Schema.Json, PeerCallError>>;
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
        Effect.map(
          (report): SpokeRow => ({
            environmentId: EnvironmentId.make(row.environment_id),
            sessionId: row.session_id as AuthSessionId,
            report,
            pairedAt: parseTime(row.paired_at) ?? DateTime.makeUnsafe(0),
            lastSeenAt: parseTime(row.last_seen_at),
          }),
        ),
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

  const redeem: PeerHub["Service"]["redeem"] = Effect.fn("PeerHub.redeem")(function* (input) {
    const joinedHub = yield* withSecrets(readHubLink).pipe(Effect.mapError(storage("join")));
    if (Option.isSome(joinedHub)) {
      return yield* new PeerJoinRefusedError({ reason: "hub-is-spoke" });
    }
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
    // Re-pairing the same machine replaces its old credential.
    if (existing !== undefined) {
      yield* auth.revokeSession(existing.sessionId).pipe(Effect.mapError(storage("join")));
      yield* sql`DELETE FROM machine_peers WHERE environment_id = ${existing.environmentId}`.pipe(
        Effect.mapError(storage("join")),
      );
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const report = yield* encodeReport(input.spoke).pipe(Effect.mapError(storage("join")));
    yield* sql`INSERT INTO machine_peers (environment_id, session_id, report_json, paired_at, last_seen_at)
      VALUES (${input.spoke.environmentId}, ${issued.session.sessionId}, ${report}, ${now}, ${now})`.pipe(
      Effect.mapError(storage("join")),
    );
    yield* publishChange;
    const self = yield* identity.self;
    return {
      accessToken: issued.token,
      expiresAt: issued.expiresAt,
      hubEnvironmentId: self.environmentId,
      scopes: issued.session.scopes.filter(isAuthPeerScope),
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
        yield* Queue.end(connection.outbox);
      }
      yield* auth.revokeSession(row.sessionId).pipe(Effect.mapError(storage("unpair")));
      yield* sql`DELETE FROM machine_peers WHERE environment_id = ${row.environmentId}`.pipe(
        Effect.mapError(storage("unpair")),
      );
      yield* publishChange;
    });

  const unpair: PeerHub["Service"]["unpair"] = Effect.fn("PeerHub.unpair")(function* (
    environmentId,
  ) {
    const row = yield* readRows.pipe(
      Effect.map((rows) => rows.find((entry) => entry.environmentId === environmentId)),
      Effect.mapError(storage("unpair")),
    );
    if (row === undefined) return false;
    yield* unpairRow(row);
    return true;
  });

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
        Effect.ensuring(Effect.sync(() => connection.pending.delete(id))),
      );
      return yield* decodePeerResult(channel, value);
    }).pipe(Effect.withSpan("PeerHub.callSpoke", { attributes: { channel: channel.name } }));

  const connect: PeerHub["Service"]["connect"] = (session) =>
    Effect.gen(function* () {
      const scopes = session.scopes.filter(isAuthPeerScope);
      let current: LiveConnection | undefined;
      const requireHello = Effect.suspend(() =>
        current === undefined
          ? Effect.fail(new PeerProtocolError({ reason: "hello-required" }))
          : Effect.succeed(current),
      );

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (current === undefined) return;
          const closing = current;
          for (const pending of closing.pending.values()) {
            yield* Deferred.fail(pending, new PeerCallError({ channel: "", reason: "disconnected" }));
          }
          yield* Queue.end(closing.outbox);
          if (live.get(closing.environmentId)?.id === closing.id) {
            live.delete(closing.environmentId);
            yield* touch(closing.environmentId);
            yield* publishChange;
          }
        }),
      );

      const hello: PeerHubConnection["hello"] = (input) =>
        Effect.gen(function* () {
          const row = yield* rowForSession(session.sessionId);
          if (row === undefined) return yield* new PeerProtocolError({ reason: "not-paired" });
          if (row.environmentId !== input.spoke.environmentId) {
            return yield* new PeerProtocolError({ reason: "machine-mismatch" });
          }
          const self = yield* identity.self;
          const signature = yield* withSecrets(
            signPeerHello({
              hubEnvironmentId: self.environmentId,
              spokeEnvironmentId: row.environmentId,
              nonce: input.nonce,
            }),
          ).pipe(Effect.orDie);
          if (current === undefined) {
            const connection: LiveConnection = {
              id: nextConnectionId++,
              environmentId: row.environmentId,
              sessionId: session.sessionId,
              outbox: yield* Queue.unbounded<PeerPush, Cause.Done>(),
              pending: new Map(),
            };
            // A spoke that reconnects before its old socket noticed the drop
            // replaces it; the old inbox ends so that socket winds down.
            const replaced = live.get(row.environmentId);
            if (replaced !== undefined) yield* Queue.end(replaced.outbox);
            live.set(row.environmentId, connection);
            current = connection;
          }
          yield* touch(row.environmentId, input.spoke);
          yield* publishChange;
          return { hubEnvironmentId: self.environmentId, signature, hub: self };
        }).pipe(Effect.withSpan("PeerHub.hello"));

      const ping: PeerHubConnection["ping"] = (input) =>
        requireHello.pipe(
          Effect.tap((connection) =>
            touch(connection.environmentId, input.spoke).pipe(
              Effect.andThen(input.spoke === undefined ? Effect.void : publishChange),
            ),
          ),
          Effect.as({}),
        );

      const machines: PeerHubConnection["machines"] = requireHello.pipe(
        Effect.andThen(hubView.pipe(Effect.orElseSucceed(() => []))),
      );

      const inbox: PeerHubConnection["inbox"] = Stream.unwrap(
        requireHello.pipe(Effect.map((connection) => Stream.fromQueue(connection.outbox))),
      );

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
      const leave: PeerHubConnection["leave"] = Effect.gen(function* () {
        const row = yield* rowForSession(session.sessionId);
        if (row !== undefined) yield* unpairRow(row).pipe(Effect.ignore({ log: true }));
        return {};
      });

      return { hello, ping, machines, inbox, reply, call, leave } satisfies PeerHubConnection;
    });

  return PeerHub.of({
    redeem,
    issueTicket,
    connect,
    spokes,
    unpair,
    callSpoke,
    changes: Stream.fromPubSub(changed),
  });
});

/** The link methods every peer must hold sync for; `peer.call` checks per channel. */
export const PEER_LINK_SCOPE: AuthPeerScope = AuthSyncReplicateScope;

export const layer = Layer.effect(PeerHub, make);

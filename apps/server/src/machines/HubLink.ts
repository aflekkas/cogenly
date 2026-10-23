/**
 * The spoke side of the machine link. A spoke redeems a peer grant at the hub
 * once, then keeps a WebSocket to the hub's `/peer` endpoint open over the
 * first route that works, reconnecting with backoff. Every connection starts
 * with `peer.hello`, whose nonce the hub signs with the environment key this
 * spoke pinned at join, so a different server answering on a route is never
 * trusted. Spokes dial the hub so nothing ever has to reach into a laptop.
 */
import {
  type MachineInfo,
  MachineError,
  type MachineJoinHubInput,
  type MachinePeerIdentity,
  type MachineSelfReport,
  PEER_JOIN_PATH,
  PEER_METHODS,
  PEER_SOCKET_PATH,
  PEER_TICKET_PATH,
  PeerCallError,
  type PeerChannel,
  PeerJoinRequest,
  PeerJoinResult,
  type PeerPush,
  PeerRpcGroup,
  PeerTicketResult,
} from "@t3tools/contracts";
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
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { type HubLinkRecord, readHubLink, removeHubLink, writeHubLink } from "./hubLinkStore.ts";
import * as MachineIdentity from "./MachineIdentity.ts";
import * as PeerChannels from "./PeerChannels.ts";
import { decodePeerResult, encodePeerPayload } from "./PeerChannels.ts";
import {
  createPeerDpopProof,
  getOrCreatePeerDpopKey,
  removePeerDpopKey,
  verifyPeerHello,
} from "./peerCrypto.ts";

export type HubLinkStatus = "connecting" | "online" | "offline" | "revoked" | "untrusted";

/** A spoke's view of its hub link. */
export interface HubLinkView {
  readonly link: HubLinkRecord;
  readonly status: HubLinkStatus;
  readonly route: string | null;
  readonly lastError: string | null;
  /** The hub's last machine list: itself and every spoke, this one included. */
  readonly machines: ReadonlyArray<MachineInfo>;
}

export class HubLink extends Context.Service<
  HubLink,
  {
    /** What a hub binds a peer grant to: this server and its peer proof key. */
    readonly peerIdentity: Effect.Effect<MachinePeerIdentity, MachineError>;
    /** Redeem a grant at the hub and start dialing it. */
    readonly join: (input: MachineJoinHubInput) => Effect.Effect<void, MachineError>;
    /** Unpair from this side: tell the hub when it is reachable, then forget it. */
    readonly leave: Effect.Effect<boolean, MachineError>;
    readonly view: Effect.Effect<Option.Option<HubLinkView>, MachineError>;
    /** The link's status, route and hub machine list: the current value, then every change. */
    readonly states: Stream.Stream<Omit<HubLinkView, "link">>;
    /** Ask the hub to run a channel request. Refused while it is offline. */
    readonly callHub: <C extends PeerChannel>(
      channel: C,
      payload: C["payload"]["Type"],
    ) => Effect.Effect<C["success"]["Type"], PeerCallError>;
    /** Emits whenever the link, its status, or the hub's machine list changes. */
    readonly changes: Stream.Stream<void>;
  }
>()("cogenly-server/machines/HubLink") {}

/** Why one connection attempt ended. */
class HubAttemptError extends Schema.TaggedError<HubAttemptError>()("HubAttemptError", {
  reason: Schema.Literals(["unreachable", "refused", "untrusted", "dropped"]),
  cause: Schema.optional(Schema.Defect()),
}) {}

type LinkState = Omit<HubLinkView, "link">;
type HubClient = RpcClient.FromGroup<typeof PeerRpcGroup, RpcClientError.RpcClientError>;

const HEARTBEAT_INTERVAL = Duration.seconds(30);
const REQUEST_TIMEOUT = Duration.seconds(15);

/**
 * Redial delays. Failures back off exponentially from `base` to `max`. A
 * revoked or untrusted link keeps retrying, slowly: a different server
 * answering on a route must not unpair this machine for good.
 */
export const HubLinkRetry = Context.Reference<{
  readonly base: Duration.Duration;
  readonly max: Duration.Duration;
  readonly refused: Duration.Duration;
}>("cogenly-server/machines/HubLink/HubLinkRetry", {
  defaultValue: () => ({
    base: Duration.seconds(1),
    max: Duration.minutes(1),
    refused: Duration.minutes(5),
  }),
});

const STATUS_MESSAGES: Record<HubAttemptError["reason"], string> = {
  unreachable: "The hub could not be reached on any of its addresses.",
  refused: "The hub refused this machine's credential. It may have unpaired this machine.",
  untrusted: "A server answered that could not prove it is the paired hub.",
  dropped: "The connection to the hub dropped.",
};

const decodeJoinResult = HttpClientResponse.schemaBodyJson(PeerJoinResult);
const decodeTicketResult = HttpClientResponse.schemaBodyJson(PeerTicketResult);
const encodeJoinRequest = HttpClientRequest.schemaBodyJson(PeerJoinRequest);

/** `https://host/x` → `wss://host/peer?wsTicket=…`. */
const socketUrl = (route: string, ticket: string) => {
  const url = new URL(PEER_SOCKET_PATH, route);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", ticket);
  return url.toString();
};

const uniqueRoutes = (routes: ReadonlyArray<string>) => [
  ...new Set(
    routes.map((route) => {
      const url = new URL(route);
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
        throw new Error("Invalid peer route");
      }
      return url.origin + "/";
    }),
  ),
];

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const http = yield* HttpClient.HttpClient;
  const webSocketConstructor = yield* Socket.WebSocketConstructor;
  const identity = yield* MachineIdentity.MachineIdentity;
  const channels = yield* PeerChannels.PeerChannels;
  const changed = yield* PubSub.unbounded<void>();
  // Wakes the dial loop: the link was created, replaced or removed.
  const kick = yield* Queue.sliding<void>(1);

  const retry = yield* HubLinkRetry;
  const state = yield* SubscriptionRef.make<LinkState>({
    status: "connecting",
    route: null,
    lastError: null,
    machines: [],
  });
  let active: HubClient | undefined;

  const withSecrets = <A, E>(effect: Effect.Effect<A, E, ServerSecretStore.ServerSecretStore>) =>
    Effect.provideService(effect, ServerSecretStore.ServerSecretStore, secrets);
  const withCrypto = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>) =>
    Effect.provideService(effect, Crypto.Crypto, crypto);
  const notify = PubSub.publish(changed, undefined).pipe(Effect.asVoid);
  const setState = (patch: Partial<LinkState>) =>
    SubscriptionRef.update(state, (current) => ({ ...current, ...patch })).pipe(
      Effect.andThen(notify),
    );

  const storage = (operation: MachineError["operation"]) => (cause: unknown) =>
    new MachineError({ operation, reason: "storage", cause });

  const randomNonce = crypto.randomUUIDv4().pipe(Effect.orDie);

  const peerIdentity: HubLink["Service"]["peerIdentity"] = Effect.gen(function* () {
    const key = yield* withSecrets(getOrCreatePeerDpopKey).pipe(
      Effect.mapError(storage("prepare-join")),
    );
    const self = yield* identity.self;
    return { environmentId: self.environmentId, name: self.name, keyThumbprint: key.thumbprint };
  }).pipe(Effect.withSpan("HubLink.peerIdentity"));

  const post = (url: string, request: HttpClientRequest.HttpClientRequest) =>
    http.execute(request).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError((cause) => new HubAttemptError({ reason: "unreachable", cause })),
      Effect.withSpan("HubLink.post", { attributes: { "url.path": new URL(url).pathname } }),
    );

  const join: HubLink["Service"]["join"] = Effect.fn("HubLink.join")(function* (input) {
    const existing = yield* withSecrets(readHubLink).pipe(Effect.mapError(storage("join")));
    if (Option.isSome(existing)) {
      return yield* new MachineError({ operation: "join", reason: "already-paired" });
    }
    const { code } = input;
    const routes = yield* Effect.try({
      try: () => uniqueRoutes([...input.hubUrls, ...code.routes]),
      catch: () => new MachineError({ operation: "join", reason: "invalid-input" }),
    });
    if (routes.length === 0) {
      return yield* new MachineError({ operation: "join", reason: "invalid-input" });
    }
    const key = yield* withSecrets(getOrCreatePeerDpopKey).pipe(Effect.mapError(storage("join")));
    const self = yield* identity.self;
    let refused = false;
    for (const route of routes) {
      const url = new URL(PEER_JOIN_PATH, route).toString();
      const nonce = yield* randomNonce;
      const proof = yield* withCrypto(createPeerDpopProof({ key, method: "POST", url })).pipe(
        Effect.orDie,
      );
      const request = yield* encodeJoinRequest(
        HttpClientRequest.post(url).pipe(HttpClientRequest.setHeader("dpop", proof)),
        { grant: code.grant, nonce, spoke: self },
      ).pipe(Effect.orDie);
      const response = yield* post(url, request).pipe(Effect.option);
      if (Option.isNone(response)) continue;
      if (response.value.status === 401 || response.value.status === 409) {
        // A spent, expired or wrong-key grant fails the same everywhere.
        refused = true;
        break;
      }
      if (response.value.status !== 200) continue;
      const result = yield* decodeJoinResult(response.value).pipe(Effect.option);
      if (Option.isNone(result)) continue;
      const joined = result.value;
      const trusted =
        joined.hubEnvironmentId === code.hubEnvironmentId &&
        verifyPeerHello({
          hubPublicKey: code.hubPublicKey,
          hubEnvironmentId: code.hubEnvironmentId,
          spokeEnvironmentId: self.environmentId,
          nonce,
          signature: joined.signature,
        });
      if (!trusted) {
        return yield* new MachineError({ operation: "join", reason: "hub-identity-mismatch" });
      }
      const now = yield* DateTime.now;
      yield* withSecrets(
        writeHubLink({
          hubEnvironmentId: code.hubEnvironmentId,
          hubName: joined.hub.name,
          hubPublicKey: code.hubPublicKey,
          routes: [route, ...routes.filter((entry) => entry !== route)],
          accessToken: joined.accessToken,
          expiresAt: joined.expiresAt,
          scopes: joined.scopes,
          pairedAt: now,
          hub: joined.hub,
          lastSeenAt: now,
          revokedAt: null,
        }),
      ).pipe(Effect.mapError(storage("join")));
      yield* setState({ status: "connecting", route, lastError: null, machines: [] });
      yield* Queue.offer(kick, undefined);
      return;
    }
    return yield* new MachineError({
      operation: "join",
      reason: refused ? "grant-rejected" : "hub-unreachable",
    });
  });

  // Forget the hub: credential, pinned key and proof key. A later pairing
  // starts from a fresh proof key.
  const forget = withSecrets(removeHubLink.pipe(Effect.andThen(removePeerDpopKey))).pipe(
    Effect.andThen(setState({ status: "connecting", route: null, lastError: null, machines: [] })),
    Effect.andThen(Queue.offer(kick, undefined)),
  );

  const leave: HubLink["Service"]["leave"] = Effect.gen(function* () {
    const existing = yield* withSecrets(readHubLink).pipe(Effect.mapError(storage("unpair")));
    if (Option.isNone(existing)) return false;
    // Best effort: an offline hub still lists this machine until it unpairs
    // it too, but its credential is useless without the key forgotten here.
    if (active !== undefined) {
      yield* active[PEER_METHODS.leave]({}).pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.ignore);
    }
    yield* forget.pipe(Effect.mapError(storage("unpair")));
    return true;
  }).pipe(Effect.withSpan("HubLink.leave"));

  const view: HubLink["Service"]["view"] = Effect.gen(function* () {
    const link = yield* withSecrets(readHubLink).pipe(Effect.mapError(storage("list")));
    if (Option.isNone(link)) return Option.none<HubLinkView>();
    const current = yield* SubscriptionRef.get(state);
    return Option.some({ link: link.value, ...current } satisfies HubLinkView);
  });

  const callHub: HubLink["Service"]["callHub"] = (channel, payload) =>
    Effect.gen(function* () {
      const client = active;
      if (client === undefined) {
        return yield* new PeerCallError({ channel: channel.name, reason: "offline" });
      }
      const encoded = yield* encodePeerPayload(channel, payload);
      const value = yield* client[PEER_METHODS.call]({
        channel: channel.name,
        payload: encoded,
      }).pipe(
        Effect.catchTags({
          PeerCallError: (error) => Effect.fail(error),
          PeerProtocolError: () =>
            Effect.fail(new PeerCallError({ channel: channel.name, reason: "disconnected" })),
          EnvironmentAuthorizationError: () =>
            Effect.fail(new PeerCallError({ channel: channel.name, reason: "forbidden" })),
          RpcClientError: () =>
            Effect.fail(new PeerCallError({ channel: channel.name, reason: "disconnected" })),
        }),
      );
      return yield* decodePeerResult(channel, value);
    }).pipe(Effect.withSpan("HubLink.callHub", { attributes: { channel: channel.name } }));

  // Requests the hub sends down the socket run like calls from it, with the
  // scopes this link holds: pairing grants the same rights both ways.
  const handlePush = (client: HubClient, link: HubLinkRecord, push: PeerPush) => {
    switch (push._tag) {
      case "Machines":
        return setState({ machines: push.machines });
      case "Unpaired":
        // The hub closes the socket right after this; forgetting must finish
        // even when that close interrupts the inbox.
        return Effect.logInfo("The hub unpaired this machine.").pipe(
          Effect.andThen(forget),
          Effect.ignore({ log: true }),
          Effect.uninterruptible,
        );
      case "Request":
        return channels
          .dispatch({
            channel: push.channel,
            payload: push.payload,
            caller: { environmentId: link.hubEnvironmentId, scopes: link.scopes },
          })
          .pipe(
            Effect.match({
              onSuccess: (value) => ({ _tag: "Success" as const, value }),
              onFailure: (error) => ({ _tag: "Failure" as const, error }),
            }),
            Effect.flatMap((result) => client[PEER_METHODS.reply]({ id: push.id, result })),
            Effect.ignore({ log: true }),
            Effect.forkScoped,
            Effect.asVoid,
          );
    }
  };

  /** One connection over one route, until it drops. Never succeeds. */
  const connectRoute = (link: HubLinkRecord, route: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const key = yield* withSecrets(getOrCreatePeerDpopKey).pipe(
          Effect.mapError((cause) => new HubAttemptError({ reason: "refused", cause })),
        );
        const ticketUrl = new URL(PEER_TICKET_PATH, route).toString();
        const proof = yield* withCrypto(
          createPeerDpopProof({
            key,
            method: "POST",
            url: ticketUrl,
            accessToken: link.accessToken,
          }),
        ).pipe(Effect.orDie);
        const response = yield* post(
          ticketUrl,
          HttpClientRequest.post(ticketUrl).pipe(
            HttpClientRequest.setHeaders({
              authorization: `DPoP ${link.accessToken}`,
              dpop: proof,
            }),
          ),
        );
        if (response.status === 401 || response.status === 403) {
          return yield* new HubAttemptError({ reason: "refused" });
        }
        const { ticket } = yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.flatMap(decodeTicketResult),
          Effect.mapError((cause) => new HubAttemptError({ reason: "unreachable", cause })),
        );

        const opened = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<void>();
        const protocol = yield* Layer.build(
          Layer.effect(
            RpcClient.Protocol,
            RpcClient.makeProtocolSocket({ retryTransientErrors: false }),
          ).pipe(
            Layer.provide(
              Layer.mergeAll(
                Socket.layerWebSocket(socketUrl(route, ticket)).pipe(
                  Layer.provide(Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor)),
                ),
                RpcSerialization.layerJson,
                Layer.succeed(RpcClient.ConnectionHooks, {
                  onConnect: Deferred.succeed(opened, undefined).pipe(Effect.asVoid),
                  onDisconnect: Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
                }),
              ),
            ),
          ),
        );
        const client = yield* RpcClient.make(PeerRpcGroup, {
          // One socket per attempt; the dial loop owns reconnecting.
          disableTracing: true,
        }).pipe(Effect.provideContext(protocol));

        const self = yield* identity.self;
        const nonce = yield* randomNonce;
        const hello = yield* client[PEER_METHODS.hello]({ nonce, spoke: self }).pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError((cause) => new HubAttemptError({ reason: "unreachable", cause })),
        );
        const trusted =
          hello.hubEnvironmentId === link.hubEnvironmentId &&
          verifyPeerHello({
            hubPublicKey: link.hubPublicKey,
            hubEnvironmentId: link.hubEnvironmentId,
            spokeEnvironmentId: self.environmentId,
            nonce,
            signature: hello.signature,
          });
        if (!trusted) return yield* new HubAttemptError({ reason: "untrusted" });

        const now = yield* DateTime.now;
        yield* withSecrets(
          writeHubLink({
            ...link,
            hub: hello.hub,
            hubName: hello.hub.name,
            lastSeenAt: now,
            routes: [route, ...link.routes.filter((entry) => entry !== route)],
          }),
        ).pipe(Effect.ignore({ log: true }));
        active = client;
        yield* Effect.addFinalizer(() => Effect.sync(() => (active = undefined)));
        yield* setState({ status: "online", route, lastError: null });

        yield* client[PEER_METHODS.inbox]({}).pipe(
          Stream.runForEach((push) => handlePush(client, link, push)),
          Effect.ensuring(Deferred.succeed(closed, undefined)),
          Effect.ignore,
          Effect.forkScoped,
        );
        // A half-open socket may never emit a disconnect. A missed heartbeat
        // must end this attempt so pending calls fail and the dial loop retries.
        const ping = (spoke?: MachineSelfReport) =>
          client[PEER_METHODS.ping](spoke === undefined ? {} : { spoke }).pipe(
            Effect.timeout(REQUEST_TIMEOUT),
            Effect.catch(() => Deferred.succeed(closed, undefined)),
          );
        yield* ping().pipe(Effect.delay(HEARTBEAT_INTERVAL), Effect.forever, Effect.forkScoped);
        yield* identity.changes.pipe(
          Stream.runForEach(() => identity.self.pipe(Effect.flatMap(ping))),
          Effect.forkScoped,
        );
        yield* Deferred.await(closed);
        return yield* new HubAttemptError({ reason: "dropped" });
      }),
    );

  /** Every route in order; the first one that connects is used until it drops. */
  const connectOnce = (link: HubLinkRecord) =>
    Effect.gen(function* () {
      let worst: HubAttemptError["reason"] = "unreachable";
      for (const route of link.routes) {
        yield* setState({ status: "connecting", route });
        const outcome = yield* connectRoute(link, route).pipe(Effect.flip);
        if (outcome.reason === "dropped") return outcome.reason;
        if (
          outcome.reason === "refused" ||
          (outcome.reason === "untrusted" && worst !== "refused")
        ) {
          worst = outcome.reason;
        }
      }
      return worst;
    });

  const statusFor = (reason: HubAttemptError["reason"]): HubLinkStatus =>
    reason === "refused" ? "revoked" : reason === "untrusted" ? "untrusted" : "offline";

  const dialLoop = Effect.gen(function* () {
    let failures = 0;
    while (true) {
      const link = yield* withSecrets(readHubLink).pipe(
        Effect.orElseSucceed(() => Option.none<HubLinkRecord>()),
      );
      if (Option.isNone(link)) {
        failures = 0;
        yield* Queue.take(kick);
        continue;
      }
      const outcome = yield* Effect.raceFirst(
        connectOnce(link.value),
        Queue.take(kick).pipe(Effect.as("changed" as const)),
      );
      if (outcome === "changed") {
        failures = 0;
        continue;
      }
      // Unpaired while connected: nothing left to report or redial.
      const still = yield* withSecrets(readHubLink).pipe(
        Effect.orElseSucceed(() => Option.none<HubLinkRecord>()),
      );
      if (Option.isNone(still)) continue;
      failures = outcome === "dropped" ? 0 : failures + 1;
      yield* setState({
        status: statusFor(outcome),
        route: null,
        lastError: STATUS_MESSAGES[outcome],
      });
      const delay =
        outcome === "refused" || outcome === "untrusted"
          ? retry.refused
          : Duration.min(Duration.times(retry.base, 2 ** Math.min(failures, 6)), retry.max);
      if (Duration.isZero(delay)) continue;
      yield* Effect.raceFirst(Effect.sleep(delay), Queue.take(kick));
    }
  });

  yield* dialLoop.pipe(Effect.forkScoped);

  return HubLink.of({
    peerIdentity,
    join,
    leave,
    view,
    states: SubscriptionRef.changes(state),
    callHub,
    changes: Stream.fromPubSub(changed),
  });
});

export const layer = Layer.effect(HubLink, make);

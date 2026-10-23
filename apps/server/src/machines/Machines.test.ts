// @effect-diagnostics nodeBuiltinImport:off -- The test serves real loopback HTTP and proxies TCP to drop sockets.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthPeerDelegateScope,
  AuthPeerScopes,
  AuthSyncReplicateScope,
  type MachineRole,
  type MachineSelfReport,
  isAuthPeerScope,
  makePeerChannel,
} from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
} from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as HubLink from "./HubLink.ts";
import { readHubLink, writeHubLink } from "./hubLinkStore.ts";
import * as MachineIdentity from "./MachineIdentity.ts";
import * as Machines from "./Machines.ts";
import * as PeerChannels from "./PeerChannels.ts";
import * as PeerHttp from "./peerHttp.ts";
import * as PeerHub from "./PeerHub.ts";
import { createPeerDpopProof, getOrCreatePeerDpopKey } from "./peerCrypto.ts";

const Echo = makePeerChannel({
  name: "test.echo",
  scope: AuthSyncReplicateScope,
  payload: Schema.Struct({ text: Schema.String }),
  success: Schema.Struct({ text: Schema.String, by: Schema.String }),
});
const Delegate = makePeerChannel({
  name: "test.delegate",
  scope: AuthPeerDelegateScope,
  payload: Schema.Struct({}),
  success: Schema.Struct({ ok: Schema.Boolean }),
});

const layerIdentity = (name: string, role: MachineRole) =>
  Layer.effect(
    MachineIdentity.MachineIdentity,
    Effect.gen(function* () {
      const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
      const report: MachineSelfReport = {
        environmentId: yield* environment.getEnvironmentId,
        name,
        role,
        hardware: role === "cloud-server" ? "server" : "laptop",
        platform: role === "cloud-server" ? "linux" : "darwin",
        serverVersion: "0.0.0-test",
        providers: [],
      };
      return MachineIdentity.MachineIdentity.of({
        self: Effect.succeed(report),
        update: () => Effect.void,
        changes: Stream.never,
      });
    }),
  );

/**
 * One Cogenly server: its own in-memory database, secrets directory,
 * environment id and keys, serving the `/peer` routes on a loopback port.
 * Redials are immediate so reconnects need no clock; a refused or untrusted
 * hub is retried only after an hour, so the status it settles on holds.
 */
const machineLayer = (name: string, role: MachineRole) => {
  const infra = Layer.mergeAll(
    SqlitePersistence.layerMemory,
    ServerSecretStore.layer,
    ServerEnvironment.layerIdentity,
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: `cogenly-machine-${name}-` }),
    ),
  );
  const machines = Machines.layer.pipe(
    Layer.provideMerge(HubLink.layer),
    Layer.provideMerge(PeerHub.layer),
    Layer.provideMerge(PeerChannels.layer),
    Layer.provideMerge(layerIdentity(name, role)),
    Layer.provideMerge(EnvironmentAuth.layer),
    Layer.provideMerge(infra),
    Layer.provide(
      Layer.mock(DirectEndpoints.DirectEndpoints)({ resolve: () => Effect.succeed([]) }),
    ),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(
      Layer.succeed(HubLink.HubLinkRetry, {
        base: Duration.zero,
        max: Duration.zero,
        refused: Duration.hours(1),
      }),
    ),
  );
  return HttpRouter.serve(PeerHttp.layer, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
    ),
    Layer.provideMerge(machines),
    Layer.provideMerge(NodeServices.layer),
  );
};

type MachineContext = Layer.Success<ReturnType<typeof machineLayer>>;

const startMachine = Effect.fn("startMachine")(function* (name: string, role: MachineRole) {
  const context = yield* Layer.build(machineLayer(name, role));
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideContext(effect, context as Context.Context<MachineContext>);
  const server = yield* run(HttpServer.HttpServer);
  const address = server.address;
  if (!("port" in address)) return yield* Effect.die("expected a TCP address");
  const machines = yield* run(Machines.Machines);
  const hubLink = yield* run(HubLink.HubLink);
  const self = yield* run(
    MachineIdentity.MachineIdentity.pipe(Effect.flatMap((identity) => identity.self)),
  );
  return {
    run,
    machines,
    hubLink,
    environmentId: self.environmentId,
    port: address.port,
    url: `http://127.0.0.1:${address.port}/`,
  };
});
type Machine = Effect.Success<ReturnType<typeof startMachine>>;

/** Pull link states until one matches; each pull waits for the next change. */
const awaitLinkState = (
  machine: Machine,
  predicate: (state: Omit<HubLink.HubLinkView, "link">) => boolean,
) =>
  Effect.gen(function* () {
    const pull = yield* Stream.toPull(machine.hubLink.states);
    while (true) {
      const states = yield* pull.pipe(Effect.orDie);
      const match = states.find(predicate);
      if (match !== undefined) return match;
    }
  }).pipe(Effect.scoped);

const pair = Effect.fn("pair")(function* (hub: Machine, spoke: Machine, hubUrl = hub.url) {
  const identity = yield* spoke.machines.prepareJoin;
  const code = yield* hub.machines.createPeerGrant({
    spokeKeyThumbprint: identity.keyThumbprint,
    spokeName: identity.name,
  });
  yield* spoke.machines.joinHub({ hubUrls: [hubUrl], code });
  yield* awaitLinkState(spoke, (state) => state.status === "online");
});

/** A TCP relay in front of a machine, so a test can cut every socket through it. */
const startProxy = (target: Machine) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly url: string;
      readonly dropAll: Effect.Effect<void>;
      readonly stallAll: Effect.Effect<void>;
      readonly server: NodeNet.Server;
    }>((resume) => {
      const sockets = new Set<NodeNet.Socket>();
      const server = NodeNet.createServer((client) => {
        const upstream = NodeNet.connect(target.port, "127.0.0.1");
        for (const socket of [client, upstream]) {
          sockets.add(socket);
          socket.on("close", () => sockets.delete(socket));
          socket.on("error", () => socket.destroy());
        }
        client.pipe(upstream).pipe(client);
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as NodeNet.AddressInfo;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${address.port}/`,
            server,
            dropAll: Effect.sync(() => {
              for (const socket of sockets) socket.destroy();
            }),
            stallAll: Effect.sync(() => {
              for (const socket of sockets) socket.pause();
            }),
          }),
        );
      });
    }),
    ({ server }) => Effect.sync(() => server.close()),
  );

describe("machines", () => {
  it.live(
    "pairs a spoke with its hub, carries calls both ways, and unpairs from the hub",
    () =>
      Effect.gen(function* () {
        const hub = yield* startMachine("hub", "cloud-server");
        const spoke = yield* startMachine("laptop", "computer");

        yield* pair(hub, spoke);

        const spokeView = yield* spoke.machines.list;
        assert.deepStrictEqual(spokeView.link, {
          _tag: "spoke",
          hubEnvironmentId: hub.environmentId,
          status: "online",
          route: hub.url,
          lastError: null,
        });
        const seenHub = spokeView.machines.find((machine) => machine.relation === "hub");
        assert.strictEqual(seenHub?.kind, "cloud-server");
        assert.strictEqual(seenHub?.online, true);
        assert.strictEqual(spokeView.machines[0]?.kind, "this-computer");

        const hubView = yield* hub.machines.list;
        assert.deepStrictEqual(hubView.link, { _tag: "hub", spokes: 1 });
        const seenSpoke = hubView.machines.find((machine) => machine.relation === "spoke");
        assert.strictEqual(seenSpoke?.kind, "other-computer");
        assert.strictEqual(seenSpoke?.online, true);
        assert.strictEqual(seenSpoke?.pairing, "paired");

        // Typed requests in both directions, each answered by the other side.
        const serve = (machine: Machine, by: string) =>
          machine.run(
            PeerChannels.PeerChannels.pipe(
              Effect.flatMap((channels) =>
                Effect.all([
                  channels.register(Echo, ({ text }) => Effect.succeed({ text, by })),
                  channels.register(Delegate, () => Effect.succeed({ ok: true })),
                ]),
              ),
            ),
          );
        yield* serve(hub, "hub");
        yield* serve(spoke, "laptop");
        assert.deepStrictEqual(
          yield* spoke.machines.call(hub.environmentId, Echo, { text: "up" }),
          { text: "up", by: "hub" },
        );
        assert.deepStrictEqual(
          yield* hub.machines.call(spoke.environmentId, Echo, { text: "down" }),
          { text: "down", by: "laptop" },
        );
        assert.deepStrictEqual(yield* hub.machines.call(spoke.environmentId, Delegate, {}), {
          ok: true,
        });

        // Unpairing on the hub revokes the session and the spoke forgets it.
        const link = yield* spoke.run(readHubLink).pipe(Effect.map(Option.getOrThrow));
        const key = yield* spoke.run(getOrCreatePeerDpopKey);
        assert.deepStrictEqual(yield* hub.machines.unpair({ environmentId: spoke.environmentId }), {
          unpaired: true,
        });
        yield* spoke.machines.subscribe.pipe(
          Stream.filter((result) => result.link._tag === "standalone"),
          Stream.runHead,
        );
        assert.isTrue(Option.isNone(yield* spoke.hubLink.view));
        assert.isTrue(Option.isNone(yield* spoke.run(readHubLink)));
        assert.deepStrictEqual((yield* hub.machines.list).link, { _tag: "standalone" });

        const ticketUrl = new URL("/peer/ticket", hub.url).toString();
        const proof = yield* hub.run(
          createPeerDpopProof({
            key,
            method: "POST",
            url: ticketUrl,
            accessToken: link.accessToken,
          }),
        );
        const response = yield* HttpClient.HttpClient.pipe(
          Effect.flatMap((client) =>
            client.execute(
              HttpClientRequest.post(ticketUrl).pipe(
                HttpClientRequest.setHeaders({
                  authorization: `DPoP ${link.accessToken}`,
                  dpop: proof,
                }),
              ),
            ),
          ),
          Effect.provide(FetchHttpClient.layer),
        );
        assert.strictEqual(response.status, 401);
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live(
    "refuses a replayed grant and a grant bound to another machine's key",
    () =>
      Effect.gen(function* () {
        const hub = yield* startMachine("hub", "cloud-server");
        const first = yield* startMachine("first", "computer");
        const second = yield* startMachine("second", "computer");
        const third = yield* startMachine("third", "computer");

        // An unbound grant (the CLI fallback) pairs whoever redeems it first, once.
        const open = yield* hub.machines.createPeerGrant({});
        const selfPair = yield* hub.machines
          .joinHub({ hubUrls: [hub.url], code: open })
          .pipe(Effect.flip);
        assert.strictEqual(selfPair.reason, "invalid-input");
        const peerHub = yield* hub.run(PeerHub.PeerHub);
        const hubSelf = yield* hub
          .run(MachineIdentity.MachineIdentity)
          .pipe(Effect.flatMap((identity) => identity.self));
        const firstKey = yield* first.run(getOrCreatePeerDpopKey);
        const spoofed = yield* peerHub
          .redeem({
            grant: open.grant,
            nonce: "self-pair",
            proofKeyThumbprint: firstKey.thumbprint,
            spoke: hubSelf,
            client: { deviceType: "bot" },
          })
          .pipe(Effect.flip);
        assert.strictEqual(spoofed._tag, "PeerJoinRefusedError");
        for (const route of [
          "not-a-url",
          "file:///etc/passwd",
          "https://name:secret@example.com",
        ]) {
          const invalid = yield* first.machines
            .joinHub({ hubUrls: [route], code: open })
            .pipe(Effect.flip);
          assert.strictEqual(invalid.reason, "invalid-input");
        }
        yield* first.machines.joinHub({ hubUrls: [hub.url], code: open });
        const replay = yield* second.machines
          .joinHub({ hubUrls: [hub.url], code: open })
          .pipe(Effect.flip);
        assert.strictEqual(replay.reason, "grant-rejected");

        // A grant bound to one machine's key is refused to any other key and
        // stays usable by the machine it was made for.
        const forSecond = yield* second.machines.prepareJoin;
        const bound = yield* hub.machines.createPeerGrant({
          spokeKeyThumbprint: forSecond.keyThumbprint,
        });
        const stolen = yield* third.machines
          .joinHub({ hubUrls: [hub.url], code: bound })
          .pipe(Effect.flip);
        assert.strictEqual(stolen.reason, "grant-rejected");
        yield* second.machines.joinHub({ hubUrls: [hub.url], code: bound });
        yield* awaitLinkState(second, (state) => state.status === "online");

        // A spoke cannot also be a hub, and a hub cannot join another.
        const spokeGrant = yield* first.machines.createPeerGrant({}).pipe(Effect.flip);
        assert.strictEqual(spokeGrant.reason, "hub-is-spoke");
        const hubJoin = yield* hub.machines.prepareJoin.pipe(Effect.flip);
        assert.strictEqual(hubJoin.reason, "spoke-is-hub");

        // Unpairing from the spoke side removes it on the hub too.
        yield* awaitLinkState(first, (state) => state.status === "online");
        assert.deepStrictEqual(yield* first.machines.unpair({ environmentId: hub.environmentId }), {
          unpaired: true,
        });
        assert.deepStrictEqual((yield* first.machines.list).link, { _tag: "standalone" });
        const remaining = yield* hub.machines.subscribe.pipe(
          Stream.filter((result) => result.link._tag === "hub" && result.link.spokes === 1),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        assert.deepStrictEqual(
          remaining.machines.map((machine) => machine.environmentId),
          [hub.environmentId, second.environmentId],
        );
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live(
    "trusts only the hub that signs with the pinned key, and reconnects after a drop",
    () =>
      Effect.gen(function* () {
        const hub = yield* startMachine("hub", "cloud-server");
        const spoke = yield* startMachine("laptop", "computer");

        // A join code naming a different hub key: the hub's signature fails.
        const otherKey = NodeCrypto.generateKeyPairSync("ed25519")
          .publicKey.export({ format: "pem", type: "spki" })
          .toString();
        const identity = yield* spoke.machines.prepareJoin;
        const code = yield* hub.machines.createPeerGrant({
          spokeKeyThumbprint: identity.keyThumbprint,
        });
        const forged = yield* spoke.machines
          .joinHub({ hubUrls: [hub.url], code: { ...code, hubPublicKey: otherKey } })
          .pipe(Effect.flip);
        assert.strictEqual(forged.reason, "hub-identity-mismatch");
        assert.isTrue(Option.isNone(yield* spoke.hubLink.view));

        // Through a relay that can cut the socket.
        const proxy = yield* startProxy(hub);
        yield* hub.machines.unpair({ environmentId: spoke.environmentId });
        yield* pair(hub, spoke, proxy.url);

        yield* proxy.dropAll;
        yield* awaitLinkState(spoke, (state) => state.status !== "online");
        yield* awaitLinkState(spoke, (state) => state.status === "online");
        const reconnected = (yield* hub.machines.list).machines.find(
          (machine) => machine.environmentId === spoke.environmentId,
        );
        assert.strictEqual(reconnected?.online, true);

        // A pinned key that no longer matches: every hello is distrusted.
        const link = yield* spoke.run(readHubLink).pipe(Effect.map(Option.getOrThrow));
        yield* spoke.run(writeHubLink({ ...link, hubPublicKey: otherKey }));
        yield* proxy.dropAll;
        const untrusted = yield* awaitLinkState(spoke, (state) => state.status === "untrusted");
        assert.isNotNull(untrusted.lastError);
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live(
    "interrupts incoming channel work and fails the caller when its socket drops",
    () =>
      Effect.gen(function* () {
        const hub = yield* startMachine("hub", "cloud-server");
        const spoke = yield* startMachine("laptop", "computer");
        const proxy = yield* startProxy(hub);
        yield* pair(hub, spoke, proxy.url);
        const started = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const channels = yield* spoke.run(PeerChannels.PeerChannels);
        yield* channels.register(Echo, () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        );
        const pending = yield* hub.machines
          .call(spoke.environmentId, Echo, { text: "pending" })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(started);
        yield* proxy.dropAll;
        yield* Deferred.await(interrupted);
        assert.strictEqual((yield* Fiber.join(pending)).reason, "disconnected");
      }).pipe(Effect.scoped),
    30_000,
  );

  it.effect(
    "reconnects when a half-open socket stops answering heartbeats",
    () =>
      Effect.gen(function* () {
        const hub = yield* startMachine("hub", "cloud-server");
        const spoke = yield* startMachine("laptop", "computer");
        const proxy = yield* startProxy(hub);
        yield* pair(hub, spoke, proxy.url);

        // Pause traffic without closing TCP: no disconnect event can rescue
        // the spoke. The heartbeat deadline must close this attempt itself.
        yield* proxy.stallAll;
        const offline = yield* awaitLinkState(spoke, (state) => state.status !== "online").pipe(
          Effect.forkScoped,
        );
        yield* TestClock.adjust("45 seconds");
        yield* Fiber.join(offline);
        yield* awaitLinkState(spoke, (state) => state.status === "online");
        assert.strictEqual((yield* hub.machines.list).machines[1]?.online, true);
        yield* proxy.dropAll;
      }).pipe(Effect.scoped),
    30_000,
  );

  it.effect(
    "expires silent spokes and refuses self reports for a different machine",
    () =>
      Effect.gen(function* () {
        const hub = yield* startMachine("hub", "cloud-server");
        const spoke = yield* startMachine("laptop", "computer");
        const peerHub = yield* hub.run(PeerHub.PeerHub);
        const self = yield* spoke
          .run(MachineIdentity.MachineIdentity)
          .pipe(Effect.flatMap((identity) => identity.self));
        const key = yield* spoke.run(getOrCreatePeerDpopKey);
        const code = yield* hub.machines.createPeerGrant({ spokeKeyThumbprint: key.thumbprint });
        const joined = yield* peerHub.redeem({
          grant: code.grant,
          nonce: "hello-nonce",
          proofKeyThumbprint: key.thumbprint,
          spoke: self,
          client: { deviceType: "bot" },
        });
        const url = new URL("/peer/ticket", hub.url).toString();
        const proof = yield* hub.run(
          createPeerDpopProof({ key, method: "POST", url, accessToken: joined.accessToken }),
        );
        const auth = yield* hub.run(EnvironmentAuth.EnvironmentAuth);
        const session = yield* auth.authenticatePeerRequest(
          HttpServerRequest.fromWeb(
            new Request(url, {
              method: "POST",
              headers: {
                host: `127.0.0.1:${hub.port}`,
                authorization: `DPoP ${joined.accessToken}`,
                dpop: proof,
              },
            }),
          ),
        );
        const connection = yield* peerHub.connect(session);
        const other = { ...self, environmentId: hub.environmentId };
        assert.strictEqual(
          (yield* connection.hello({ nonce: "hello", spoke: other }).pipe(Effect.flip)).reason,
          "machine-mismatch",
        );
        yield* connection.hello({ nonce: "hello", spoke: self });
        assert.strictEqual(
          (yield* connection.ping({ spoke: other }).pipe(Effect.flip)).reason,
          "machine-mismatch",
        );
        assert.strictEqual(
          (yield* hub.machines.list).machines[1]?.environmentId,
          spoke.environmentId,
        );
        assert.strictEqual((yield* hub.machines.list).machines[1]?.online, true);

        yield* TestClock.adjust("75 seconds");
        const offline = yield* hub.machines.subscribe.pipe(
          Stream.filter((result) => result.machines[1]?.online === false),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        assert.strictEqual(offline.machines[1]?.pairing, "paired");
        assert.strictEqual((yield* connection.ping({}).pipe(Effect.flip)).reason, "not-paired");
        assert.strictEqual(
          (yield* hub.machines
            .call(spoke.environmentId, Echo, { text: "offline" })
            .pipe(Effect.flip)).reason,
          "offline",
        );
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live(
    "accepts a peer session only on /peer",
    () =>
      Effect.gen(function* () {
        const hub = yield* startMachine("hub", "cloud-server");
        const auth = yield* hub.run(EnvironmentAuth.EnvironmentAuth);
        const key = yield* hub.run(getOrCreatePeerDpopKey);
        const grant = yield* auth.issuePeerGrant({
          label: "Laptop",
          proofKeyThumbprint: key.thumbprint,
        });
        const issued = yield* auth.redeemPeerGrant({
          credential: grant.credential,
          proofKeyThumbprint: key.thumbprint,
          client: { deviceType: "bot" },
        });
        assert.deepStrictEqual(issued.session.scopes, [...AuthPeerScopes]);

        const dpopRequest = (path: string) =>
          Effect.gen(function* () {
            const url = new URL(path, hub.url).toString();
            const dpop = yield* hub.run(
              createPeerDpopProof({ key, method: "POST", url, accessToken: issued.token }),
            );
            return HttpServerRequest.fromWeb(
              new Request(url, {
                method: "POST",
                headers: {
                  host: `127.0.0.1:${hub.port}`,
                  authorization: `DPoP ${issued.token}`,
                  dpop,
                },
              }),
            );
          });

        // The peer endpoint takes it.
        const peer = yield* auth.authenticatePeerRequest(yield* dpopRequest("/peer/ticket"));
        assert.strictEqual(peer.sessionId, issued.session.sessionId);

        // The HTTP API, which file reads and every other route go through, does not.
        const http = yield* auth
          .authenticateHttpRequest(yield* dpopRequest("/api/project/files"))
          .pipe(Effect.flip);
        assert.strictEqual(http._tag, "ServerAuthInvalidCredentialError");

        // Nor the /ws upgrade that carries every client RPC, terminals included.
        const wsTicket = yield* auth.issueWebSocketTicket(peer);
        const ws = yield* auth
          .authenticateWebSocketUpgrade(
            HttpServerRequest.fromWeb(new Request(`${hub.url}ws?wsTicket=${wsTicket.ticket}`)),
          )
          .pipe(Effect.flip);
        assert.strictEqual(ws._tag, "ServerAuthInvalidCredentialError");
        const peerTicket = yield* auth.issueWebSocketTicket(peer);
        yield* auth.authenticatePeerWebSocket(
          HttpServerRequest.fromWeb(new Request(`${hub.url}peer?wsTicket=${peerTicket.ticket}`)),
        );

        // Nor /mcp.
        const mcp = yield* auth
          .authenticateMcpClient(
            HttpServerRequest.fromWeb(
              new Request(`${hub.url}mcp`, {
                headers: { authorization: `Bearer ${issued.token}` },
              }),
            ),
          )
          .pipe(Effect.flip);
        assert.strictEqual(mcp._tag, "ServerAuthInvalidCredentialError");

        // No client RPC is authorized by a peer scope.
        for (const scope of Object.values(RPC_REQUIRED_SCOPES)) {
          assert.isFalse(isAuthPeerScope(scope));
        }

        // A peer grant never becomes a client session, and a client session
        // never passes for a peer.
        const second = yield* auth.issuePeerGrant({ label: "Other" });
        const exchanged = yield* auth
          .exchangeBootstrapCredentialForAccessToken(second.credential, undefined, {
            deviceType: "bot",
          })
          .pipe(Effect.flip);
        assert.strictEqual(exchanged._tag, "ServerAuthInvalidCredentialError");
        const admin = yield* auth.issueSession();
        const asPeer = yield* auth
          .authenticatePeerRequest(
            HttpServerRequest.fromWeb(
              new Request(`${hub.url}peer/ticket`, {
                method: "POST",
                headers: { authorization: `Bearer ${admin.token}` },
              }),
            ),
          )
          .pipe(Effect.flip);
        assert.include(
          ["ServerAuthMissingCredentialError", "ServerAuthInvalidCredentialError"],
          asPeer._tag,
        );
      }).pipe(Effect.scoped),
    30_000,
  );
});

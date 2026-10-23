import { startMachine, awaitLinkState, pair, startProxy, type Machine } from "./testkit.ts";
// @effect-diagnostics nodeBuiltinImport:off -- The test serves real loopback HTTP and proxies TCP to drop sockets.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import {
  AuthPeerDelegateScope,
  AuthPeerScopes,
  AuthSyncReplicateScope,
  isAuthPeerScope,
  makePeerChannel,
} from "@t3tools/contracts";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as Deferred from "effect/Deferred";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServerRequest } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";

import { readHubLink, writeHubLink } from "./hubLinkStore.ts";
import * as MachineIdentity from "./MachineIdentity.ts";

import * as PeerChannels from "./PeerChannels.ts";

import * as PeerHub from "./PeerHub.ts";
import { acceptsPeerIngress } from "./peerIngress.ts";
import { normalizePeerRoute, normalizePeerRoutes } from "./peerRoutes.ts";
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

const startHttpObserver = (handler: NodeHttp.RequestListener) =>
  Effect.acquireRelease(
    Effect.callback<{ server: NodeHttp.Server; url: string }>((resume) => {
      const server = NodeHttp.createServer(handler);
      server.listen(0, "127.0.0.1", () =>
        resume(
          Effect.succeed({
            server,
            url: `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}/`,
          }),
        ),
      );
    }),
    ({ server }) =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  );

describe("machines", () => {
  it("accepts only loopback sockets, with explicit Serve forwarding and no public proxy markers", () => {
    const config = { tailscaleServeEnabled: true };
    const serve = {
      "x-forwarded-for": "100.64.0.2",
      "x-forwarded-host": "hub.ts.net",
      "x-forwarded-proto": "https",
    };
    const request = (remote: string | undefined, headers: Record<string, string> = {}) =>
      HttpServerRequest.fromWeb(new Request("http://127.0.0.1/peer", { headers })).modify({
        remoteAddress: Option.fromUndefinedOr(remote),
      });
    for (const remote of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      assert.isTrue(acceptsPeerIngress(request(remote), config));
      assert.isTrue(acceptsPeerIngress(request(remote, serve), config));
    }
    for (const remote of [undefined, "203.0.113.1", "100.64.0.2", "localhost"]) {
      assert.isFalse(acceptsPeerIngress(request(remote, serve), config));
    }
    for (const headers of [
      { ...serve, "cf-ray": "edge-ray", "tailscale-user-login": "spoof@example.com" },
      { ...serve, "cf-connecting-ip": "203.0.113.1" },
      { ...serve, "tailscale-funnel-request": "?1" },
      { ...serve, "x-forwarded-for": "203.0.113.1" },
      { ...serve, "x-forwarded-for": "abc:.ts.net" },
      { ...serve, "x-forwarded-for": "100.64..2" },
      { ...serve, "x-forwarded-for": "100.64.0.2, 203.0.113.1" },
      { ...serve, forwarded: "for=203.0.113.1" },
      { ...serve, "x-forwarded-proto": "http" },
      { "x-forwarded-host": "hub.ts.net" },
    ])
      assert.isFalse(acceptsPeerIngress(request("127.0.0.1", headers), config));
    assert.isFalse(
      acceptsPeerIngress(request("127.0.0.1", serve), { tailscaleServeEnabled: false }),
    );
    assert.isFalse(
      acceptsPeerIngress(request("127.0.0.1"), { ...config, peerIngress: "disabled" }),
    );
  });

  it.live(
    "refuses all peer endpoints through Connect and public proxies before authentication",
    () =>
      Effect.gen(function* () {
        const hub = yield* startMachine("hub", "cloud-server");
        const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
        for (const path of ["peer/identity", "peer/join", "peer/ticket", "peer"]) {
          for (const headers of [
            {
              "cf-ray": "edge",
              "x-forwarded-for": "100.64.0.2",
              "x-forwarded-proto": "https",
              "x-forwarded-host": "hub.ts.net",
              "tailscale-user-login": "spoof@example.com",
            },
            { "x-forwarded-for": "203.0.113.1", "x-forwarded-proto": "https" },
          ]) {
            const response = yield* client.execute(
              HttpClientRequest.make(path === "peer" ? "GET" : "POST")(hub.url + path).pipe(
                HttpClientRequest.setHeaders(headers),
              ),
            );
            assert.strictEqual(response.status, 403);
            assert.deepStrictEqual(yield* response.json, { code: "private_peer_ingress_required" });
          }
        }
        // The boundary did not disable local pairing.
        const spoke = yield* startMachine("spoke", "computer");
        yield* pair(hub, spoke);
      }).pipe(Effect.scoped),
    30_000,
  );

  it("permits TLS or loopback routes, without a plaintext fallback", () => {
    assert.strictEqual(normalizePeerRoute("wss://hub.example/path"), "https://hub.example/");
    assert.strictEqual(normalizePeerRoute("ws://[::1]:4773/"), "http://[::1]:4773/");
    for (const route of [
      "http://hub.ts.net/",
      "http://100.64.0.2/",
      "ws://10.0.0.1/",
      "http://example.com/",
      "https://user:secret@hub.example/",
    ]) {
      assert.throws(() => normalizePeerRoute(route));
    }
    assert.throws(() => normalizePeerRoutes(["https://hub.example/", "http://127.0.0.1:4773/"]));
  });

  it.live(
    "rejects unsafe route lists before dialing and sends no grant to an untrusted hub or redirect",
    () =>
      Effect.gen(function* () {
        const hub = yield* startMachine("hub", "cloud-server");
        const spoke = yield* startMachine("spoke", "computer");
        const identity = yield* spoke.machines.prepareJoin;
        const code = yield* hub.machines.createPeerGrant({
          spokeKeyThumbprint: identity.keyThumbprint,
        });
        const received: { path: string; authorization: string | undefined }[] = [];
        const observer = yield* startHttpObserver((request, response) => {
          received.push({ path: request.url!, authorization: request.headers.authorization });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ hubEnvironmentId: hub.environmentId, signature: "wrong" }));
        });
        for (const routes of [
          [observer.url, "http://100.64.0.2/"],
          ["https://hub.example/", observer.url],
        ]) {
          const error = yield* spoke.machines.joinHub({ hubUrls: routes, code }).pipe(Effect.flip);
          assert.strictEqual(error.reason, "invalid-input");
          assert.deepStrictEqual(received, []);
        }
        const wrong = yield* spoke.machines
          .joinHub({ hubUrls: [observer.url], code })
          .pipe(Effect.flip);
        assert.strictEqual(wrong.reason, "hub-identity-mismatch");
        assert.deepStrictEqual(received, [{ path: "/peer/identity", authorization: undefined }]);
        const redirect = yield* startHttpObserver((_request, response) => {
          response.writeHead(307, { location: observer.url + "peer/join" });
          response.end();
        });
        const redirected = yield* spoke.machines
          .joinHub({ hubUrls: [redirect.url], code })
          .pipe(Effect.flip);
        assert.strictEqual(redirected.reason, "hub-unreachable");
        assert.strictEqual(received.length, 1);
        // Neither preflight spent the grant; the intended hub still accepts it.
        yield* spoke.machines.joinHub({ hubUrls: [hub.url], code });
        yield* awaitLinkState(spoke, (state) => state.status === "online");
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live(
    "checks saved routes and the pinned hub before sending a reconnect token",
    () =>
      Effect.gen(function* () {
        for (const unsafeRoutes of [true, false]) {
          const hub = yield* startMachine("hub", "cloud-server");
          const spoke = yield* startMachine("spoke", "computer");
          const proxy = yield* startProxy(hub);
          yield* pair(hub, spoke, proxy.url);
          const received: {
            path: string;
            authorization: string | undefined;
            dpop: string | string[] | undefined;
          }[] = [];
          const observer = yield* startHttpObserver((request, response) => {
            received.push({
              path: request.url!,
              authorization: request.headers.authorization,
              dpop: request.headers.dpop,
            });
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({ hubEnvironmentId: hub.environmentId, signature: "wrong" }),
            );
          });
          const link = yield* spoke.run(readHubLink).pipe(Effect.map(Option.getOrThrow));
          yield* spoke.run(
            writeHubLink({
              ...link,
              routes: unsafeRoutes ? ["https://hub.example/", observer.url] : [observer.url],
            }),
          );
          yield* proxy.dropAll;
          yield* awaitLinkState(spoke, (state) => state.status === "untrusted");
          assert.deepStrictEqual(
            received,
            unsafeRoutes
              ? []
              : [{ path: "/peer/identity", authorization: undefined, dpop: undefined }],
          );
        }
      }).pipe(Effect.scoped),
    30_000,
  );

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

        // A key-bound grant pairs only its intended spoke, once.
        const preparedFirst = yield* first.machines.prepareJoin;
        const open = yield* hub.machines.createPeerGrant({
          spokeKeyThumbprint: preparedFirst.keyThumbprint,
        });
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
        const spokeGrant = yield* first.machines
          .createPeerGrant({ spokeKeyThumbprint: preparedFirst.keyThumbprint })
          .pipe(Effect.flip);
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
        const second = yield* auth.issuePeerGrant({
          label: "Other",
          proofKeyThumbprint: key.thumbprint,
        });
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

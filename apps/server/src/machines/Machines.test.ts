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
  PEER_PROTOCOL_VERSION,
  PeerAuthenticatedFrame,
  isAuthPeerScope,
  makePeerChannel,
} from "@cogenly/contracts";

import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";

import * as Deferred from "effect/Deferred";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServerRequest } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";

import { readHubLink, writeHubLink } from "./hubLinkStore.ts";
import * as MachineIdentity from "./MachineIdentity.ts";

import * as PeerChannels from "./PeerChannels.ts";

import * as PeerHub from "./PeerHub.ts";
import { PeerFrameCodec } from "./peerFrames.ts";
import { acceptsPeerIngress } from "./peerIngress.ts";
import { normalizePeerRoute, normalizePeerRoutes } from "./peerRoutes.ts";
import {
  createPeerDpopProof,
  getOrCreatePeerDpopKey,
  signPeerProof,
  peerDigest,
  peerJoinProofTranscript,
  peerJoinTranscript,
  peerHelloProofTranscript,
  peerHelloTranscript,
  canonicalPeerJson,
  createPeerEphemeral,
  derivePeerSessionKey,
  hubPublicKey,
  signPeerTranscript,
  verifyPeerTranscript,
} from "./peerCrypto.ts";

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

type RelayDirection = "spoke-to-hub" | "hub-to-spoke";
type AuthenticatedFrame = typeof PeerAuthenticatedFrame.Type;

/** An active relay at the socket boundary, forwarding real sockets to the real hub. */
const makeActiveRelay = () => {
  type Forward = (direction: RelayDirection, wire: string) => void;
  let intercept: (direction: RelayDirection, wire: string, forward: Forward) => void = (
    direction,
    wire,
    forward,
  ) => forward(direction, wire);
  let dropCurrent = () => {};
  let sendCurrent: Forward = () => {
    throw new Error("relay not connected");
  };
  const constructor: Socket.WebSocketConstructor["Service"] = (url) => {
    const socket = new globalThis.WebSocket(url);
    dropCurrent = () => socket.close();
    const listeners = new Set<(event: Socket.WebSocketEvent) => void>();
    const forward: Forward = (direction, wire) => {
      if (direction === "spoke-to-hub") socket.send(wire);
      else for (const listener of listeners) listener({ data: wire });
    };
    sendCurrent = forward;
    socket.addEventListener("message", (event) => {
      assert.isString(event.data);
      intercept("hub-to-spoke", event.data, forward);
    });
    return {
      get readyState() {
        return socket.readyState;
      },
      addEventListener(type, listener, options) {
        if (type === "message") listeners.add(listener);
        else socket.addEventListener(type, listener, options);
      },
      removeEventListener(type, listener) {
        if (type === "message") listeners.delete(listener);
        else socket.removeEventListener(type, listener);
      },
      close: (code, reason) => socket.close(code, reason),
      send: (data) =>
        intercept(
          "spoke-to-hub",
          typeof data === "string" ? data : new TextDecoder().decode(data),
          forward,
        ),
    };
  };
  return {
    constructor,
    intercept: (handler: typeof intercept) => {
      intercept = handler;
    },
    inject: (direction: RelayDirection, wire: string) => sendCurrent(direction, wire),
    drop: () => dropCurrent(),
  };
};

const authFrame = (wire: string) =>
  Schema.decodeUnknownOption(PeerAuthenticatedFrame)(JSON.parse(wire));

/** Mutate every leaf, including nested report fields, and every array as a whole. */
function* transcriptMutations(value: Schema.Json): Generator<Schema.Json> {
  if (Array.isArray(value)) {
    yield [...value, "tampered"];
    for (const [index, item] of value.entries())
      for (const changed of transcriptMutations(item)) {
        yield value.map((original, i) => (i === index ? changed : original));
      }
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value))
      for (const changed of transcriptMutations(item)) {
        yield { ...value, [key]: changed };
      }
  } else
    yield typeof value === "string"
      ? value + "tampered"
      : typeof value === "number"
        ? value + 1
        : value === null
          ? false
          : !value;
}

describe("machines", () => {
  it.live("authenticates every join and hello transcript field with distinct domains", () =>
    Effect.gen(function* () {
      const hub = yield* startMachine("hub", "cloud-server");
      const spoke = yield* startMachine("spoke", "computer");
      const self = yield* spoke
        .run(MachineIdentity.MachineIdentity)
        .pipe(Effect.flatMap((identity) => identity.self));
      const hubReport = yield* hub
        .run(MachineIdentity.MachineIdentity)
        .pipe(Effect.flatMap((identity) => identity.self));
      const publicKey = yield* hub.run(hubPublicKey);
      const key = yield* spoke.run(getOrCreatePeerDpopKey);
      const fields = {
        hubPublicKey: publicKey,
        hubEnvironmentId: hub.environmentId,
        spokeKeyThumbprint: key.thumbprint,
        spoke: self,
        nonce: "fresh-nonce",
        accessTokenHash: peerDigest("token"),
        scopes: [...AuthPeerScopes],
        expiresAt: "2027-01-01T00:00:00.000Z",
        hub: hubReport,
      };
      const joinFields = { ...fields, grantHash: peerDigest("grant") };
      const helloFields = {
        ...fields,
        challenge: {
          version: PEER_PROTOCOL_VERSION,
          connectionId: "fresh-connection",
          hubEphemeralKey: createPeerEphemeral().publicKey,
        },
        spokeEphemeralKey: createPeerEphemeral().publicKey,
      };
      const join = peerJoinTranscript(joinFields);
      const hello = peerHelloTranscript(helloFields);
      for (const [transcript, other, expectedFields, domain] of [
        [join, hello, joinFields, "cogenly-peer-join"],
        [hello, join, helloFields, "cogenly-peer-hello"],
      ] as const) {
        const signature = yield* hub.run(signPeerTranscript(transcript));
        assert.isTrue(verifyPeerTranscript(publicKey, transcript, signature));
        assert.deepStrictEqual(JSON.parse(transcript), {
          domain,
          version: PEER_PROTOCOL_VERSION,
          fields: expectedFields,
        });
        const json = yield* Schema.decodeUnknownEffect(Schema.Json)(JSON.parse(transcript));
        for (const changed of transcriptMutations(json)) {
          assert.isFalse(verifyPeerTranscript(publicKey, canonicalPeerJson(changed), signature));
        }
        assert.isFalse(verifyPeerTranscript(publicKey, other, signature));
        assert.strictEqual(
          transcript,
          canonicalPeerJson({ version: PEER_PROTOCOL_VERSION, fields: expectedFields, domain }),
        );
      }
    }).pipe(Effect.scoped),
  );

  it("binds every frame header and payload to its session before RPC decoding", () => {
    const spoke = createPeerEphemeral();
    const hub = createPeerEphemeral();
    const key = derivePeerSessionKey(spoke.privateKey, hub.publicKey, "signed-hello");
    assert.deepStrictEqual(
      key,
      derivePeerSessionKey(hub.privateKey, spoke.publicKey, "signed-hello"),
    );
    assert.isFalse(
      key.equals(derivePeerSessionKey(hub.privateKey, spoke.publicKey, "different-hello")),
    );
    const sender = new PeerFrameCodec("spoke");
    sender.establish("connection", key);
    const request = {
      _tag: "Request",
      id: "1",
      tag: "peer.call",
      payload: { channel: "test.echo", payload: { text: "original" } },
      headers: [],
    };
    const encoded = sender.serialization.makeUnsafe().encode(request);
    if (typeof encoded !== "string") throw new Error("Expected a serialized frame");
    const frame = Schema.decodeUnknownSync(PeerAuthenticatedFrame)(JSON.parse(encoded));
    for (const changed of [
      { connectionId: "another-connection" },
      { direction: "hub-to-spoke" },
      { sequence: 2 },
      { sequence: 0 },
      { sequence: Number.MAX_SAFE_INTEGER + 1 },
      { method: "peer.leave" },
      { payload: frame.payload.replace("test.echo", "another.channel") },
      { payload: frame.payload.replace("original", "forged") },
      { mac: "forged" },
    ]) {
      const receiver = new PeerFrameCodec("hub");
      receiver.establish("connection", key);
      assert.throws(
        () => receiver.serialization.makeUnsafe().decode(JSON.stringify({ ...frame, ...changed })),
        "Peer frame authentication failed",
      );
      assert.isTrue(Deferred.isDoneUnsafe(receiver.failed));
    }
    const receiver = new PeerFrameCodec("hub");
    receiver.establish("connection", key);
    const parser = receiver.serialization.makeUnsafe();
    assert.deepStrictEqual(parser.decode(encoded), [request]);
    assert.throws(() => parser.decode(encoded), "Peer frame authentication failed");
    const reconnected = new PeerFrameCodec("hub");
    reconnected.establish(
      "new-connection",
      derivePeerSessionKey(hub.privateKey, spoke.publicKey, "new-signed-hello"),
    );
    assert.throws(
      () => reconnected.serialization.makeUnsafe().decode(encoded),
      "Peer frame authentication failed",
    );
  });

  it.live(
    "rejects a captured call after reconnecting with the same pairing",
    () =>
      Effect.gen(function* () {
        const relay = makeActiveRelay();
        const hub = yield* startMachine("hub", "cloud-server");
        const spoke = yield* startMachine("spoke", "computer", relay.constructor);
        yield* pair(hub, spoke);
        const channels = yield* hub.run(PeerChannels.PeerChannels);
        const dispatched: string[] = [];
        yield* channels.register(Echo, ({ text }) =>
          Effect.sync(() => {
            dispatched.push(text);
            return { text, by: "hub" };
          }),
        );
        let captured = "";
        relay.intercept((direction, wire, forward) => {
          const frame = authFrame(wire);
          if (
            direction === "spoke-to-hub" &&
            Option.isSome(frame) &&
            frame.value.method === "peer.call"
          )
            captured = wire;
          forward(direction, wire);
        });
        yield* spoke.machines.call(hub.environmentId, Echo, { text: "first-session" });
        const token = (yield* spoke.run(readHubLink).pipe(Effect.map(Option.getOrThrow)))
          .accessToken;
        const dropped = yield* awaitLinkState(spoke, (state) => state.status !== "online").pipe(
          Effect.forkScoped,
        );
        yield* Effect.sync(() => relay.drop());
        yield* Fiber.join(dropped);
        yield* awaitLinkState(spoke, (state) => state.status === "online");
        assert.strictEqual(
          (yield* spoke.run(readHubLink).pipe(Effect.map(Option.getOrThrow))).accessToken,
          token,
        );
        relay.intercept((direction, wire, forward) => {
          const frame = authFrame(wire);
          if (
            direction === "spoke-to-hub" &&
            Option.isSome(frame) &&
            frame.value.method === "peer.call"
          ) {
            const previous = Option.getOrThrow(authFrame(captured));
            assert.notStrictEqual(frame.value.connectionId, previous.connectionId);
            forward(direction, captured);
          } else forward(direction, wire);
        });
        const rejected = yield* spoke.machines
          .call(hub.environmentId, Echo, { text: "second-session" })
          .pipe(Effect.flip);
        assert.strictEqual(rejected.reason, "disconnected");
        assert.deepStrictEqual(dispatched, ["first-session"]);
      }).pipe(Effect.scoped),
    30_000,
  );

  const relayKinds = ["call-up", "call-down", "reply-up", "reply-down"] as const;
  const relayAttacks = ["tamper", "replay", "reorder", "reflect"] as const;
  it.live.each(relayKinds.flatMap((kind) => relayAttacks.map((attack) => ({ kind, attack }))))(
    "rejects relay $attack of $kind before dispatch or accepting a reply",
    ({ kind, attack }) =>
      Effect.gen(function* () {
        const relay = makeActiveRelay();
        const hub = yield* startMachine("hub", "cloud-server");
        const spoke = yield* startMachine("spoke", "computer", relay.constructor);
        yield* pair(hub, spoke);
        const dispatched: string[] = [];
        for (const [machine, by] of [
          [hub, "hub"],
          [spoke, "spoke"],
        ] as const) {
          const channels = yield* machine.run(PeerChannels.PeerChannels);
          yield* channels.register(Echo, ({ text }) =>
            Effect.sync(() => {
              dispatched.push(text);
              return { text, by };
            }),
          );
        }
        const hubChannels = yield* hub.run(PeerChannels.PeerChannels);
        const spokeChannels = yield* spoke.run(PeerChannels.PeerChannels);
        yield* hubChannels.register(Delegate, () => Effect.succeed({ ok: true }));
        yield* spokeChannels.register(Delegate, () => Effect.succeed({ ok: true }));
        yield* hub.machines.call(spoke.environmentId, Delegate, {});
        const call = (text: string) =>
          kind === "call-up" || kind === "reply-down"
            ? spoke.machines.call(hub.environmentId, Echo, { text })
            : hub.machines.call(spoke.environmentId, Echo, { text });
        const matches = (direction: RelayDirection, frame: AuthenticatedFrame) =>
          kind === "call-up"
            ? direction === "spoke-to-hub" && frame.method === "peer.call"
            : kind === "call-down"
              ? direction === "hub-to-spoke" &&
                frame.method === "Chunk" &&
                frame.payload.includes('"_tag":"Request"')
              : kind === "reply-up"
                ? direction === "spoke-to-hub" && frame.method === "peer.reply"
                : direction === "hub-to-spoke" &&
                  frame.method === "Exit" &&
                  frame.payload.includes('"by":"hub"');
        let captured: string | undefined;
        const held = yield* Deferred.make<void>();
        const attacked = yield* Deferred.make<void>();
        relay.intercept((direction, wire, forward) => {
          const frame = authFrame(wire);
          if (
            Option.isNone(frame) ||
            (!matches(direction, frame.value) &&
              !(
                kind === "call-down" &&
                attack === "reorder" &&
                captured !== undefined &&
                direction === "hub-to-spoke"
              ))
          ) {
            forward(direction, wire);
            return;
          }
          if (attack === "replay" && captured === undefined) {
            captured = wire;
            forward(direction, wire);
            return;
          }
          if (attack === "reorder" && captured === undefined) {
            captured = wire;
            Deferred.doneUnsafe(held, Effect.void);
            return;
          }
          relay.intercept((nextDirection, nextWire, nextForward) =>
            nextForward(nextDirection, nextWire),
          );
          if (attack === "tamper")
            forward(
              direction,
              JSON.stringify({
                ...frame.value,
                payload: frame.value.payload.replaceAll("attack", "forged"),
              }),
            );
          else if (attack === "replay") forward(direction, captured!);
          else if (attack === "reorder") {
            forward(direction, wire);
            forward(direction, captured!);
          } else forward(direction === "spoke-to-hub" ? "hub-to-spoke" : "spoke-to-hub", wire);
          Deferred.doneUnsafe(attacked, Effect.void);
        });
        if (attack === "replay") assert.strictEqual((yield* call("warmup")).text, "warmup");
        const first = yield* call("attack-1").pipe(Effect.result, Effect.forkScoped);
        let second: typeof first | undefined;
        if (attack === "reorder") {
          yield* Deferred.await(held);
          second = yield* (
            kind === "call-down"
              ? spoke.machines
                  .call(hub.environmentId, Delegate, {})
                  .pipe(Effect.as({ text: "barrier", by: "hub" }))
              : call("attack-2")
          ).pipe(Effect.result, Effect.forkScoped);
        }
        yield* Deferred.await(attacked);
        const result = yield* Fiber.join(first);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure.reason, "disconnected");
        if (second !== undefined) assert.strictEqual((yield* Fiber.join(second))._tag, "Failure");
        const expected = kind.startsWith("call")
          ? attack === "replay"
            ? ["warmup"]
            : []
          : attack === "replay"
            ? ["warmup", "attack-1"]
            : attack === "reorder"
              ? ["attack-1", "attack-2"]
              : ["attack-1"];
        assert.deepStrictEqual(dispatched, expected);
        assert.isTrue(Option.isSome(yield* spoke.run(readHubLink)));
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live.each(["tamper", "reorder", "reflect", "replay"] as const)(
    "rejects relay %s of Unpaired without forgetting the pairing",
    (attack) =>
      Effect.gen(function* () {
        const relay = makeActiveRelay();
        const hub = yield* startMachine("hub", "cloud-server");
        const spoke = yield* startMachine("spoke", "computer", relay.constructor);
        yield* pair(hub, spoke);
        const channels = yield* spoke.run(PeerChannels.PeerChannels);
        yield* channels.register(Echo, ({ text }) => Effect.succeed({ text, by: "spoke" }));
        // A completed hub call proves the inbox is subscribed before unpairing.
        yield* hub.machines.call(spoke.environmentId, Echo, { text: "ready" });
        const held = yield* Deferred.make<void>();
        const attacked = yield* Deferred.make<void>();
        let captured = "";
        let earlier = "";
        relay.intercept((direction, wire, forward) => {
          const frame = authFrame(wire);
          if (
            attack === "reorder" &&
            direction === "hub-to-spoke" &&
            Option.isSome(frame) &&
            frame.value.method === "Exit" &&
            frame.value.payload.includes('"by":"hub"')
          ) {
            earlier = wire;
            Deferred.doneUnsafe(held, Effect.void);
            return;
          }
          if (
            direction !== "hub-to-spoke" ||
            Option.isNone(frame) ||
            !frame.value.payload.includes('"_tag":"Unpaired"')
          ) {
            forward(direction, wire);
            return;
          }
          captured = wire;
          if (attack === "tamper")
            forward(
              direction,
              JSON.stringify({ ...frame.value, payload: frame.value.payload + " " }),
            );
          else if (attack === "reorder") {
            forward(direction, wire);
            forward(direction, earlier);
          } else if (attack === "reflect") forward("spoke-to-hub", wire);
          // Replay captures a real notice and withholds it until a new pairing/session.
          Deferred.doneUnsafe(attacked, Effect.void);
        });
        if (attack === "reorder") {
          const hubChannels = yield* hub.run(PeerChannels.PeerChannels);
          yield* hubChannels.register(Echo, ({ text }) => Effect.succeed({ text, by: "hub" }));
          yield* spoke.machines
            .call(hub.environmentId, Echo, { text: "held" })
            .pipe(Effect.ignore, Effect.forkScoped);
          yield* Deferred.await(held);
        }
        yield* hub.machines.unpair({ environmentId: spoke.environmentId });
        yield* Deferred.await(attacked);
        yield* awaitLinkState(spoke, (state) => state.status === "revoked");
        assert.isTrue(Option.isSome(yield* spoke.run(readHubLink)));
        if (attack === "replay") {
          yield* spoke.machines.unpair({ environmentId: hub.environmentId });
          relay.intercept((direction, wire, forward) => forward(direction, wire));
          yield* pair(hub, spoke);
          const newLink = yield* spoke.run(readHubLink).pipe(Effect.map(Option.getOrThrow));
          const dropped = yield* awaitLinkState(spoke, (state) => state.status !== "online").pipe(
            Effect.forkScoped,
          );
          yield* Effect.sync(() => relay.inject("hub-to-spoke", captured));
          yield* Fiber.join(dropped);
          assert.strictEqual(
            (yield* spoke.run(readHubLink).pipe(Effect.map(Option.getOrThrow))).accessToken,
            newLink.accessToken,
          );
          yield* awaitLinkState(spoke, (state) => state.status === "online");
        }
      }).pipe(Effect.scoped),
    30_000,
  );

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

  it.live("an expired saved peer session is revoked even before a connection change", () =>
    Effect.gen(function* () {
      const hub = yield* startMachine("hub", "cloud-server");
      const spoke = yield* startMachine("laptop", "computer");
      yield* pair(hub, spoke);
      const link = yield* spoke.run(readHubLink).pipe(Effect.map(Option.getOrThrow));
      yield* spoke.run(writeHubLink({ ...link, expiresAt: DateTime.makeUnsafe(0) }));
      const view = yield* spoke.machines.list;
      assert.strictEqual(
        view.machines.find((machine) => machine.relation === "hub")?.pairing,
        "revoked",
      );
      assert.strictEqual(
        view.machines.find((machine) => machine.relation === "hub")?.online,
        false,
      );
      assert.strictEqual(view.link._tag === "spoke" && view.link.status, "revoked");
    }).pipe(Effect.scoped),
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
        assert.deepStrictEqual(yield* spoke.machines.call(hub.environmentId, Delegate, {}), {
          ok: true,
        });
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
            proofKey: firstKey.publicJwk,
            proof: "invalid",
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
        // A body proof is checked before a grant is consumed or a report is stored.
        const validProof = signPeerProof(
          key,
          peerJoinProofTranscript({
            hubPublicKey: code.hubPublicKey,
            hubEnvironmentId: hub.environmentId,
            spokeKeyThumbprint: key.thumbprint,
            spoke: self,
            nonce: "join-proof",
            grantHash: peerDigest(code.grant),
          }),
        );
        for (const changed of [
          { spoke: { ...self, name: "forged" } },
          { nonce: "forged" },
          { proof: "forged" },
          { grant: "forged" },
          { proofKey: { ...key.publicJwk, x: "forged" } },
        ]) {
          const refused = yield* peerHub
            .redeem({
              grant: code.grant,
              nonce: "join-proof",
              proofKeyThumbprint: key.thumbprint,
              spoke: self,
              proofKey: key.publicJwk,
              proof: validProof,
              client: { deviceType: "bot" },
              ...changed,
            })
            .pipe(Effect.flip);
          assert.strictEqual(refused._tag, "PeerJoinRefusedError");
          assert.strictEqual((yield* hub.machines.list).machines.length, 1);
        }
        const joined = yield* peerHub.redeem({
          proofKey: key.publicJwk,
          proof: signPeerProof(
            key,
            peerJoinProofTranscript({
              hubPublicKey: code.hubPublicKey,
              hubEnvironmentId: hub.environmentId,
              spokeKeyThumbprint: key.thumbprint,
              spoke: self,
              nonce: "hello-nonce",
              grantHash: peerDigest(code.grant),
            }),
          ),
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
        const incompatible = yield* peerHub.connect(session);
        const mismatch = yield* incompatible.challenge({ version: 1 }).pipe(Effect.flip);
        assert.strictEqual(mismatch.reason, "version-mismatch");
        assert.include(mismatch.message, "upgrade both machines");
        for (const field of [
          "proof",
          "nonce",
          "spoke",
          "spokeEphemeralKey",
          "proofKey",
          "accessToken",
        ] as const) {
          yield* Effect.gen(function* () {
            const rejected = yield* peerHub.connect(session);
            const challenge = yield* rejected.challenge({ version: PEER_PROTOCOL_VERSION });
            const ephemeral = createPeerEphemeral();
            const input = {
              version: PEER_PROTOCOL_VERSION,
              nonce: "proof-nonce",
              spoke: self,
              accessToken: joined.accessToken,
              proofKey: key.publicJwk,
              spokeEphemeralKey: ephemeral.publicKey,
              proof: signPeerProof(
                key,
                peerHelloProofTranscript({
                  hubPublicKey: code.hubPublicKey,
                  hubEnvironmentId: hub.environmentId,
                  spokeKeyThumbprint: key.thumbprint,
                  spoke: self,
                  nonce: "proof-nonce",
                  accessTokenHash: peerDigest(joined.accessToken),
                  challenge,
                  spokeEphemeralKey: ephemeral.publicKey,
                }),
              ),
            };
            const tampered =
              field === "spoke"
                ? { ...input, spoke: { ...self, name: "forged" } }
                : field === "proofKey"
                  ? { ...input, proofKey: { ...input.proofKey, x: "forged" } }
                  : { ...input, [field]: "forged" };
            const error = yield* rejected.hello(tampered).pipe(Effect.flip);
            assert.strictEqual(error.reason, "invalid-proof");
            const listed = yield* hub.machines.list;
            assert.strictEqual(listed.machines[1]?.online, false);
            assert.strictEqual(listed.machines[1]?.name, self.name);
          }).pipe(Effect.scoped);
        }
        const connection = yield* peerHub.connect(session);
        const challenge = yield* connection.challenge({ version: PEER_PROTOCOL_VERSION });
        const ephemeral = createPeerEphemeral();
        const helloInput = {
          version: PEER_PROTOCOL_VERSION,
          nonce: "hello",
          spoke: self,
          accessToken: joined.accessToken,
          proofKey: key.publicJwk,
          spokeEphemeralKey: ephemeral.publicKey,
          proof: signPeerProof(
            key,
            peerHelloProofTranscript({
              hubPublicKey: code.hubPublicKey,
              hubEnvironmentId: hub.environmentId,
              spokeKeyThumbprint: key.thumbprint,
              spoke: self,
              nonce: "hello",
              accessTokenHash: peerDigest(joined.accessToken),
              challenge,
              spokeEphemeralKey: ephemeral.publicKey,
            }),
          ),
        };
        const other = { ...self, environmentId: hub.environmentId };
        assert.strictEqual(
          (yield* connection.hello({ ...helloInput, spoke: other }).pipe(Effect.flip)).reason,
          "machine-mismatch",
        );
        yield* connection.hello(helloInput);
        yield* Effect.gen(function* () {
          const replay = yield* peerHub.connect(session);
          yield* replay.challenge({ version: PEER_PROTOCOL_VERSION });
          assert.strictEqual(
            (yield* replay.hello(helloInput).pipe(Effect.flip)).reason,
            "invalid-proof",
          );
        }).pipe(Effect.scoped);
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

import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthSyncReplicateScope,
  makePeerChannel,
  PEER_PROTOCOL_VERSION,
} from "@cogenly/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpServerRequest } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SqlClient from "effect/sql/SqlClient";

import * as MachineIdentity from "./MachineIdentity.ts";
import * as PeerHub from "./PeerHub.ts";
import {
  getOrCreatePeerDpopKey,
  createPeerDpopProof,
  createPeerEphemeral,
  peerHelloProofTranscript,
  peerDigest,
  peerJoinProofTranscript,
  signPeerProof,
} from "./peerCrypto.ts";
import { startMachine, type Machine } from "./testkit.ts";

const redeem = Effect.fn(function* (hub: Machine, spoke: Machine) {
  const peerHub = yield* hub.run(PeerHub.PeerHub);
  const self = yield* spoke
    .run(MachineIdentity.MachineIdentity)
    .pipe(Effect.flatMap((identity) => identity.self));
  const key = yield* spoke.run(getOrCreatePeerDpopKey);
  const code = yield* hub.machines.createPeerGrant({ spokeKeyThumbprint: key.thumbprint });
  const nonce = "join";
  const joined = yield* peerHub.redeem({
    proofKey: key.publicJwk,
    proof: signPeerProof(
      key,
      peerJoinProofTranscript({
        hubPublicKey: code.hubPublicKey,
        hubEnvironmentId: hub.environmentId,
        spokeKeyThumbprint: key.thumbprint,
        spoke: self,
        nonce,
        grantHash: peerDigest(code.grant),
      }),
    ),
    grant: code.grant,
    nonce,
    proofKeyThumbprint: key.thumbprint,
    spoke: self,
    client: { deviceType: "bot" },
  });
  return { joined, key, self, code, peerHub };
});

it.effect("an unpair holding an old session cannot delete a replacement row", () =>
  Effect.gen(function* () {
    const revoking = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const hub = yield* startMachine("hub", "cloud-server", undefined, {
      auth: (auth) => ({
        ...auth,
        revokeSession: (id) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(revoking, undefined);
            yield* Deferred.await(release);
            return yield* auth.revokeSession(id);
          }),
      }),
    });
    const spoke = yield* startMachine("spoke", "computer");
    const { peerHub } = yield* redeem(hub, spoke);
    const unpair = yield* peerHub.unpair(spoke.environmentId).pipe(Effect.forkChild);
    yield* Deferred.await(revoking);
    const sql = yield* hub.run(SqlClient.SqlClient);
    const replacement = AuthSessionId.make("replacement-session");
    // Model the row committed by a replacement redemption while revocation is suspended.
    yield* sql`UPDATE machine_peers SET session_id = ${replacement} WHERE environment_id = ${spoke.environmentId}`;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(unpair);
    const rows = yield* sql<{
      session_id: string;
    }>`SELECT session_id FROM machine_peers WHERE environment_id = ${spoke.environmentId}`;
    assert.deepStrictEqual(
      rows.map((row) => row.session_id),
      [replacement],
    );
  }).pipe(Effect.scoped),
);

const Echo = makePeerChannel({
  name: "test.disconnect",
  scope: AuthSyncReplicateScope,
  payload: Schema.String,
  success: Schema.String,
});

const connectSpoke = Effect.fn(function* (hub: Machine, spoke: Machine) {
  const { joined, key, self, code, peerHub } = yield* redeem(hub, spoke);
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
          host: new URL(url).host,
          authorization: `DPoP ${joined.accessToken}`,
          dpop: proof,
        },
      }),
    ),
  );
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const connection = yield* peerHub
    .connect(session)
    .pipe(Effect.provideService(Scope.Scope, scope));
  const challenge = yield* connection.challenge({ version: PEER_PROTOCOL_VERSION });
  const ephemeral = createPeerEphemeral();
  yield* connection.hello({
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
  });
  return { peerHub, scope, connection };
});

it.effect("a call registering after disconnect fails instead of waiting forever", () =>
  Effect.gen(function* () {
    const captured = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let armed = false;
    const hub = yield* startMachine("hub", "cloud-server", undefined, {
      crypto: (crypto) => ({
        ...crypto,
        randomUUIDv4: () =>
          Effect.gen(function* () {
            if (armed) {
              yield* Deferred.succeed(captured, undefined);
              yield* Deferred.await(resume);
            }
            return yield* crypto.randomUUIDv4();
          }),
      }),
    });
    const spoke = yield* startMachine("spoke", "computer");
    const { peerHub, scope } = yield* connectSpoke(hub, spoke);
    armed = true;
    const call = yield* peerHub
      .callSpoke(spoke.environmentId, Echo, "hello")
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(captured);
    yield* Scope.close(scope, Exit.void);
    yield* Deferred.succeed(resume, undefined);
    const result = yield* Fiber.join(call);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.strictEqual(result.failure.reason, "disconnected");
      assert.strictEqual(result.failure.channel, Echo.name);
    }
  }).pipe(Effect.scoped),
);

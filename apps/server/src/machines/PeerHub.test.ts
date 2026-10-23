import { assert, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";

import * as MachineIdentity from "./MachineIdentity.ts";
import * as PeerHub from "./PeerHub.ts";
import {
  getOrCreatePeerDpopKey,
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

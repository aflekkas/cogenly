/**
 * The two keys of the peer link. A spoke signs DPoP proofs with its own P-256
 * key, so its peer token is useless without that key. A hub signs each
 * `peer.hello` nonce with its environment Ed25519 key, which the spoke pinned
 * when it joined.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no key generation or signing.
import * as NodeCrypto from "node:crypto";

import { peerHelloSigningInput } from "@t3tools/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  DpopPublicJwk,
  normalizeDpopHtu,
} from "@t3tools/shared/dpop";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";

const decodeDpopPublicJwk = Schema.decodeUnknownEffect(DpopPublicJwk);

const PEER_DPOP_KEY_SECRET = "machine-peer-dpop-key";

const StoredDpopKey = Schema.Struct({
  privateJwk: Schema.Record(Schema.String, Schema.String),
  publicJwk: DpopPublicJwk,
});
const StoredDpopKeyJson = Schema.fromJsonString(StoredDpopKey);
const decodeStoredDpopKey = Schema.decodeUnknownEffect(StoredDpopKeyJson);
const encodeStoredDpopKey = Schema.encodeEffect(StoredDpopKeyJson);

export interface PeerDpopKey {
  readonly privateKey: NodeCrypto.KeyObject;
  readonly publicJwk: DpopPublicJwk;
  readonly thumbprint: string;
}

const toPeerDpopKey = (stored: typeof StoredDpopKey.Type): PeerDpopKey => ({
  privateKey: NodeCrypto.createPrivateKey({ key: stored.privateJwk, format: "jwk" }),
  publicJwk: stored.publicJwk,
  thumbprint: computeDpopJwkThumbprint(stored.publicJwk),
});

const readPeerDpopKey = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const stored = yield* secrets.get(PEER_DPOP_KEY_SECRET);
  if (Option.isNone(stored)) return Option.none<PeerDpopKey>();
  const decoded = yield* decodeStoredDpopKey(new TextDecoder().decode(stored.value)).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSecretStore.SecretStoreDecodeError({ resource: "machine peer key", cause }),
    ),
  );
  return Option.some(toPeerDpopKey(decoded));
});

/** This server's peer proof key, created on first use. */
export const getOrCreatePeerDpopKey = Effect.gen(function* () {
  const existing = yield* readPeerDpopKey;
  if (Option.isSome(existing)) return existing.value;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const generated = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const privateJwk = generated.privateKey.export({ format: "jwk" });
  const publicJwk = yield* decodeDpopPublicJwk(generated.publicKey.export({ format: "jwk" })).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSecretStore.SecretStoreDecodeError({ resource: "machine peer key", cause }),
    ),
  );
  const stored = {
    privateJwk: Object.fromEntries(
      Object.entries(privateJwk).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    publicJwk,
  };
  const encoded = yield* encodeStoredDpopKey(stored).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSecretStore.SecretStoreEncodeError({ resource: "machine peer key", cause }),
    ),
  );
  yield* secrets.set(PEER_DPOP_KEY_SECRET, new TextEncoder().encode(encoded));
  return toPeerDpopKey(stored);
});

/** Unpairing forgets the key so the next pairing starts from a fresh one. */
export const removePeerDpopKey = ServerSecretStore.ServerSecretStore.pipe(
  Effect.flatMap((secrets) => secrets.remove(PEER_DPOP_KEY_SECRET)),
);

const encodeProofHeader = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ typ: Schema.String, alg: Schema.String, jwk: DpopPublicJwk }),
  ),
);
const encodeProofPayload = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      htm: Schema.String,
      htu: Schema.String,
      jti: Schema.String,
      iat: Schema.Number,
      ath: Schema.optionalKey(Schema.String),
    }),
  ),
);

/** An RFC 9449 proof for one request, bound to `accessToken` when given. */
export const createPeerDpopProof = Effect.fn("createPeerDpopProof")(function* (input: {
  readonly key: PeerDpopKey;
  readonly method: string;
  readonly url: string;
  readonly accessToken?: string;
}) {
  const crypto = yield* Crypto.Crypto;
  const jti = yield* crypto.randomUUIDv4();
  const now = yield* DateTime.now;
  const header = Buffer.from(
    encodeProofHeader({ typ: "dpop+jwt", alg: "ES256", jwk: input.key.publicJwk }),
  ).toString("base64url");
  const payload = Buffer.from(
    encodeProofPayload({
      htm: input.method.toUpperCase(),
      htu: normalizeDpopHtu(input.url) ?? input.url,
      jti,
      iat: Math.floor(now.epochMilliseconds / 1000),
      ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: input.key.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
});

/** The hub's public key as a spoke pins it: SPKI PEM. */
export const hubPublicKey = ServerSecretStore.ServerSecretStore.pipe(
  Effect.flatMap(getOrCreateEnvironmentKeyPairFromSecretStore),
  Effect.map((pair) => pair.publicKey.trim()),
);

export const signPeerHello = Effect.fn("signPeerHello")(function* (input: {
  readonly hubEnvironmentId: string;
  readonly spokeEnvironmentId: string;
  readonly nonce: string;
}) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const pair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
  return NodeCrypto.sign(
    null,
    Buffer.from(peerHelloSigningInput(input)),
    NodeCrypto.createPrivateKey(pair.privateKey),
  ).toString("base64url");
});

/** True only when `signature` is the pinned hub key's signature over this hello. */
export function verifyPeerHello(input: {
  readonly hubPublicKey: string;
  readonly hubEnvironmentId: string;
  readonly spokeEnvironmentId: string;
  readonly nonce: string;
  readonly signature: string;
}): boolean {
  try {
    return NodeCrypto.verify(
      null,
      Buffer.from(peerHelloSigningInput(input)),
      NodeCrypto.createPublicKey(input.hubPublicKey),
      Buffer.from(input.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

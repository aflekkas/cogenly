/** Handshake transcripts, endpoint proofs and ephemeral peer-session keys. */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no key generation or signing.
import * as NodeCrypto from "node:crypto";

import {
  type MachineSelfReport,
  type AuthPeerScope,
  type PeerChallengeResult,
  PEER_PROTOCOL_VERSION,
} from "@cogenly/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  DpopPublicJwk,
  normalizeDpopHtu,
} from "@cogenly/shared/dpop";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

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

// Locks belong to the supplied store, so separate environments never block each other.
// Creation and removal share the lock; no key or service is cached here.
const keyLocks = new WeakMap<ServerSecretStore.ServerSecretStore["Service"], Semaphore.Semaphore>();
const withKeyLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    let lock = keyLocks.get(secrets);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      keyLocks.set(secrets, lock);
    }
    return yield* lock.withPermit(effect);
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
}).pipe(withKeyLock);

/** Unpairing forgets the key so the next pairing starts from a fresh one. */
export const removePeerDpopKey = ServerSecretStore.ServerSecretStore.pipe(
  Effect.flatMap((secrets) => secrets.remove(PEER_DPOP_KEY_SECRET)),
  withKeyLock,
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

/** Sorted object keys, preserved array order, UTF-8 JSON; never delimiter concatenation. */
export function canonicalPeerJson(value: unknown): string {
  const sort = (json: Schema.Json): Schema.Json =>
    Array.isArray(json)
      ? json.map(sort)
      : json !== null && typeof json === "object"
        ? Object.fromEntries(
            Object.entries(json)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, value]) => [key, sort(value)]),
          )
        : json;
  return JSON.stringify(
    sort(Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(value)))),
  );
}

export const peerDigest = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("base64url");

const transcript = (purpose: string, fields: unknown) =>
  canonicalPeerJson({ domain: `cogenly-peer-${purpose}`, version: PEER_PROTOCOL_VERSION, fields });

export const peerIdentityTranscript = (input: {
  readonly hubEnvironmentId: string;
  readonly spokeEnvironmentId: string;
  readonly nonce: string;
}) =>
  transcript("identity", {
    hubEnvironmentId: input.hubEnvironmentId,
    spokeEnvironmentId: input.spokeEnvironmentId,
    nonce: input.nonce,
  });

export interface PeerJoinProofFields {
  readonly hubPublicKey: string;
  readonly hubEnvironmentId: string;
  readonly spokeKeyThumbprint: string;
  readonly spoke: MachineSelfReport;
  readonly nonce: string;
  readonly grantHash: string;
}

export const peerJoinProofTranscript = (input: PeerJoinProofFields) =>
  transcript("join-proof", input);

export interface PeerHandshakeFields {
  readonly hubPublicKey: string;
  readonly hubEnvironmentId: string;
  readonly spokeKeyThumbprint: string;
  readonly spoke: MachineSelfReport;
  readonly nonce: string;
  readonly accessTokenHash: string;
  readonly scopes: ReadonlyArray<AuthPeerScope>;
  readonly expiresAt: string;
  readonly hub: MachineSelfReport;
}

export const peerJoinTranscript = (input: PeerHandshakeFields & { readonly grantHash: string }) =>
  transcript("join", input);

export interface PeerHelloProofFields {
  readonly hubPublicKey: string;
  readonly hubEnvironmentId: string;
  readonly spokeKeyThumbprint: string;
  readonly spoke: MachineSelfReport;
  readonly nonce: string;
  readonly accessTokenHash: string;
  readonly challenge: PeerChallengeResult;
  readonly spokeEphemeralKey: string;
}

export const peerHelloProofTranscript = (input: PeerHelloProofFields) =>
  transcript("hello-proof", input);
export const peerHelloTranscript = (
  input: PeerHandshakeFields & {
    readonly challenge: PeerChallengeResult;
    readonly spokeEphemeralKey: string;
  },
) => transcript("hello", input);

export const signPeerTranscript = Effect.fn("signPeerTranscript")(function* (input: string) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const pair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
  return NodeCrypto.sign(
    null,
    Buffer.from(input),
    NodeCrypto.createPrivateKey(pair.privateKey),
  ).toString("base64url");
});

export function verifyPeerTranscript(
  hubPublicKey: string,
  input: string,
  signature: string,
): boolean {
  try {
    return NodeCrypto.verify(
      null,
      Buffer.from(input),
      NodeCrypto.createPublicKey(hubPublicKey),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export const signPeerProof = (key: PeerDpopKey, input: string) =>
  NodeCrypto.sign("sha256", Buffer.from(input), {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");

export function verifyPeerProof(
  publicJwk: DpopPublicJwk,
  thumbprint: string,
  input: string,
  proof: string,
): boolean {
  try {
    return (
      computeDpopJwkThumbprint(publicJwk) === thumbprint &&
      NodeCrypto.verify(
        "sha256",
        Buffer.from(input),
        {
          key: NodeCrypto.createPublicKey({ key: publicJwk, format: "jwk" }),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(proof, "base64url"),
      )
    );
  } catch {
    return false;
  }
}

/** Both ephemeral keys are authenticated by the hello transcript and the spoke proof. */
export const createPeerEphemeral = () => {
  const key = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey: key.privateKey,
    publicKey: key.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  };
};

export function derivePeerSessionKey(
  privateKey: NodeCrypto.KeyObject,
  publicKey: string,
  helloTranscript: string,
): Buffer {
  const remote = NodeCrypto.createPublicKey({
    key: Buffer.from(publicKey, "base64url"),
    format: "der",
    type: "spki",
  });
  if (remote.asymmetricKeyType !== "ec" || remote.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("Invalid peer ECDH key");
  const shared = NodeCrypto.diffieHellman({ privateKey, publicKey: remote });
  return Buffer.from(
    NodeCrypto.hkdfSync(
      "sha256",
      shared,
      Buffer.from(peerDigest(helloTranscript), "base64url"),
      "cogenly-peer-session:v2",
      32,
    ),
  );
}

export const peerMac = (key: Buffer, input: unknown) =>
  NodeCrypto.createHmac("sha256", key).update(canonicalPeerJson(input)).digest("base64url");

export function verifyPeerMac(key: Buffer, input: unknown, mac: string): boolean {
  const expected = Buffer.from(peerMac(key, input), "base64url");
  const actual = Buffer.from(mac, "base64url");
  return actual.length === expected.length && NodeCrypto.timingSafeEqual(actual, expected);
}

/**
 * Pure vault cryptography (node:crypto only, no Effect, no I/O).
 *
 * Key hierarchy: each environment owns an X25519 key pair. An item body is
 * encrypted once with a random 256-bit data key (AES-256-GCM); that data key
 * is wrapped once per allowed machine with ECDH (X25519) + HKDF-SHA256 +
 * AES-256-GCM, with the environment id in the AAD. Adding a machine later is
 * just another wrapped-key entry; the ciphertext never changes.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- node:crypto is the vault primitive.
import * as NodeCrypto from "node:crypto";

import { canonicalPeerJson, peerDigest } from "../machines/peerCrypto.ts";

export interface VaultKeyPair {
  readonly publicKey: string; // base64 SPKI DER
  readonly privateKey: string; // base64 PKCS8 DER
}

export interface WrappedDataKey {
  readonly environmentId: string;
  readonly ephemeralPublicKey: string; // base64
  readonly nonce: string; // base64
  readonly ciphertext: string; // base64, AES-GCM ciphertext with tag appended
}

export interface EncryptedBody {
  readonly nonce: string; // base64
  readonly ciphertext: string; // base64, tag appended
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const unb64 = (text: string) => Buffer.from(text, "base64");

const keyObjectFromRaw = (encoded: string, type: "public" | "private"): NodeCrypto.KeyObject => {
  const der = unb64(encoded);
  return type === "public"
    ? NodeCrypto.createPublicKey({ key: der, format: "der", type: "spki" })
    : NodeCrypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
};

const encodeKeyObject = (key: NodeCrypto.KeyObject, type: "public" | "private"): string =>
  b64(
    key.export(
      type === "public" ? { format: "der", type: "spki" } : { format: "der", type: "pkcs8" },
    ),
  );

/** Generates this environment's X25519 key pair. Storage is the caller's job. */
export const generateKeyPair = (): VaultKeyPair => {
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("x25519");
  return {
    publicKey: encodeKeyObject(publicKey, "public"),
    privateKey: encodeKeyObject(privateKey, "private"),
  };
};

const aesGcmEncrypt = (key: Buffer, plaintext: Buffer, aad?: Buffer): EncryptedBody => {
  const nonce = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { nonce: b64(nonce), ciphertext: b64(ciphertext) };
};

const aesGcmDecrypt = (key: Buffer, body: EncryptedBody, aad?: Buffer): Buffer => {
  const raw = unb64(body.ciphertext);
  if (raw.length < 17) throw new Error("Ciphertext is too short.");
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, unb64(body.nonce));
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
};

const deriveWrapKey = (shared: Buffer, environmentId: string, itemId: string): Buffer =>
  Buffer.from(
    NodeCrypto.hkdfSync(
      "sha256",
      shared,
      Buffer.from(environmentId, "utf8"),
      Buffer.from(`cogenly-vault-wrap:v1:${itemId}`, "utf8"),
      32,
    ),
  );

export const wrapDataKey = (input: {
  readonly recipientPublicKey: string;
  readonly dataKey: Uint8Array;
  readonly environmentId: string;
  readonly itemId: string;
}): WrappedDataKey => {
  const ephemeral = NodeCrypto.generateKeyPairSync("x25519");
  const shared = NodeCrypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: keyObjectFromRaw(input.recipientPublicKey, "public"),
  });
  const wrapKey = deriveWrapKey(shared, input.environmentId, input.itemId);
  const encrypted = aesGcmEncrypt(
    wrapKey,
    Buffer.from(input.dataKey),
    Buffer.from(input.environmentId, "utf8"),
  );
  return {
    environmentId: input.environmentId,
    ephemeralPublicKey: encodeKeyObject(ephemeral.publicKey, "public"),
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
  };
};

export const unwrapDataKey = (input: {
  readonly wrapped: WrappedDataKey;
  readonly privateKey: string;
  readonly itemId: string;
}): Uint8Array => {
  const shared = NodeCrypto.diffieHellman({
    privateKey: keyObjectFromRaw(input.privateKey, "private"),
    publicKey: keyObjectFromRaw(input.wrapped.ephemeralPublicKey, "public"),
  });
  const wrapKey = deriveWrapKey(shared, input.wrapped.environmentId, input.itemId);
  return aesGcmDecrypt(
    wrapKey,
    { nonce: input.wrapped.nonce, ciphertext: input.wrapped.ciphertext },
    Buffer.from(input.wrapped.environmentId, "utf8"),
  );
};

export const randomDataKey = (): Uint8Array => NodeCrypto.randomBytes(32);

export const encryptBody = (input: {
  readonly dataKey: Uint8Array;
  readonly plaintext: string;
  readonly itemId: string;
}): EncryptedBody =>
  aesGcmEncrypt(
    Buffer.from(input.dataKey),
    Buffer.from(input.plaintext, "utf8"),
    Buffer.from(input.itemId, "utf8"),
  );

export const decryptBody = (input: {
  readonly dataKey: Uint8Array;
  readonly body: EncryptedBody;
  readonly itemId: string;
}): string =>
  aesGcmDecrypt(Buffer.from(input.dataKey), input.body, Buffer.from(input.itemId, "utf8")).toString(
    "utf8",
  );

/** True for a base64 SPKI DER X25519 public key, the only kind a vault peer may pin. */
export const isX25519PublicKey = (encoded: string): boolean => {
  try {
    return keyObjectFromRaw(encoded, "public").asymmetricKeyType === "x25519";
  } catch {
    return false;
  }
};

/**
 * Synced vault documents (docs/internals/vault-sync.md). `sealed` is the item
 * payload under a fresh data key per revision; its AAD binds the field clock
 * SharedState assigned, so a relay cannot replay an old value under a newer
 * clock. Each recipient gets its own `wrap:<id>` field holding that data key.
 */
export interface VaultSealed {
  readonly v: 1;
  readonly author: string;
  readonly nonce: string;
  readonly ciphertext: string;
}

export interface VaultWrap {
  readonly v: 1;
  /** The holder that made this wrap; the recipient checks it against a key it trusts. */
  readonly by: string;
  readonly sealedDigest: string;
  readonly ephemeralPublicKey: string;
  readonly nonce: string;
  readonly ciphertext: string;
}

export interface VaultSealClock {
  readonly wall: number;
  readonly logical: number;
  readonly node: string;
}

const sealedAad = (itemId: string, author: string, clock: VaultSealClock) =>
  Buffer.from(
    canonicalPeerJson({
      domain: "cogenly-vault-sealed",
      v: 1,
      itemId,
      author,
      clock: { wall: clock.wall, logical: clock.logical, node: clock.node },
    }),
    "utf8",
  );

export const sealVaultPayload = (input: {
  readonly dataKey: Uint8Array;
  readonly plaintext: string;
  readonly itemId: string;
  readonly author: string;
  readonly clock: VaultSealClock;
}): VaultSealed => {
  const body = aesGcmEncrypt(
    Buffer.from(input.dataKey),
    Buffer.from(input.plaintext, "utf8"),
    sealedAad(input.itemId, input.author, input.clock),
  );
  return { v: 1, author: input.author, nonce: body.nonce, ciphertext: body.ciphertext };
};

/** Throws unless `sealed` was made for this item, by its author, at exactly `clock`. */
export const openVaultPayload = (input: {
  readonly dataKey: Uint8Array;
  readonly sealed: VaultSealed;
  readonly itemId: string;
  readonly clock: VaultSealClock;
}): string =>
  aesGcmDecrypt(
    Buffer.from(input.dataKey),
    { nonce: input.sealed.nonce, ciphertext: input.sealed.ciphertext },
    sealedAad(input.itemId, input.sealed.author, input.clock),
  ).toString("utf8");

/** What a wrap commits to; covers every key of the stored value, newer ones included. */
export const sealedDigestOf = (sealed: unknown): string => peerDigest(canonicalPeerJson(sealed));

const wrapInfo = (itemId: string, by: string, recipient: string) =>
  canonicalPeerJson({ domain: "cogenly-vault-wrap", v: 2, itemId, by, recipient });

/**
 * Authenticated wrap: the key mixes an ephemeral DH with the sender's static
 * DH, so only a holder of `by`'s private key can produce one that verifies.
 */
const deriveAuthenticatedWrapKey = (
  ephemeralShared: Buffer,
  staticShared: Buffer,
  sealedDigest: string,
  info: string,
): Buffer =>
  Buffer.from(
    NodeCrypto.hkdfSync(
      "sha256",
      Buffer.concat([ephemeralShared, staticShared]),
      Buffer.from(sealedDigest, "base64url"),
      Buffer.from(info, "utf8"),
      32,
    ),
  );

export const wrapVaultDataKey = (input: {
  readonly dataKey: Uint8Array;
  readonly itemId: string;
  readonly sealed: VaultSealed;
  readonly by: string;
  readonly senderPrivateKey: string;
  readonly recipient: string;
  readonly recipientPublicKey: string;
}): VaultWrap => {
  const recipientKey = keyObjectFromRaw(input.recipientPublicKey, "public");
  const ephemeral = NodeCrypto.generateKeyPairSync("x25519");
  const sealedDigest = sealedDigestOf(input.sealed);
  const info = wrapInfo(input.itemId, input.by, input.recipient);
  const wrapKey = deriveAuthenticatedWrapKey(
    NodeCrypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientKey }),
    NodeCrypto.diffieHellman({
      privateKey: keyObjectFromRaw(input.senderPrivateKey, "private"),
      publicKey: recipientKey,
    }),
    sealedDigest,
    info,
  );
  const encrypted = aesGcmEncrypt(wrapKey, Buffer.from(input.dataKey), Buffer.from(info, "utf8"));
  return {
    v: 1,
    by: input.by,
    sealedDigest,
    ephemeralPublicKey: encodeKeyObject(ephemeral.publicKey, "public"),
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
  };
};

/**
 * Throws unless the wrap was made for `recipient` by the holder of
 * `senderPublicKey`, over exactly this `sealed` value.
 */
export const unwrapVaultDataKey = (input: {
  readonly wrap: VaultWrap;
  readonly itemId: string;
  readonly sealed: VaultSealed;
  readonly recipient: string;
  readonly recipientPrivateKey: string;
  readonly senderPublicKey: string;
}): Uint8Array => {
  const sealedDigest = sealedDigestOf(input.sealed);
  if (input.wrap.sealedDigest !== sealedDigest) throw new Error("Wrap is for another revision.");
  const privateKey = keyObjectFromRaw(input.recipientPrivateKey, "private");
  const info = wrapInfo(input.itemId, input.wrap.by, input.recipient);
  const wrapKey = deriveAuthenticatedWrapKey(
    NodeCrypto.diffieHellman({
      privateKey,
      publicKey: keyObjectFromRaw(input.wrap.ephemeralPublicKey, "public"),
    }),
    NodeCrypto.diffieHellman({
      privateKey,
      publicKey: keyObjectFromRaw(input.senderPublicKey, "public"),
    }),
    sealedDigest,
    info,
  );
  const dataKey = aesGcmDecrypt(
    wrapKey,
    { nonce: input.wrap.nonce, ciphertext: input.wrap.ciphertext },
    Buffer.from(info, "utf8"),
  );
  if (dataKey.length !== 32) throw new Error("Wrapped data key has the wrong length.");
  return dataKey;
};

/**
 * Where this environment's private key lives. Today that is a file in the
 * server secret store; on macOS this seam is where a Keychain-backed store
 * replaces it without touching the crypto above.
 */
export interface VaultMachineKeyStore {
  readonly loadOrCreateKeyPair: () => Promise<VaultKeyPair>;
}

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

/**
 * True for a base64 SPKI DER X25519 public key that a key exchange accepts,
 * the only kind a vault peer may pin. A low-order point parses as X25519 but
 * yields no shared secret, which would fail every later wrap for that peer.
 */
export const isX25519PublicKey = (encoded: string): boolean => {
  try {
    const key = keyObjectFromRaw(encoded, "public");
    if (key.asymmetricKeyType !== "x25519") return false;
    const trial = NodeCrypto.generateKeyPairSync("x25519");
    return NodeCrypto.diffieHellman({ privateKey: trial.privateKey, publicKey: key }).some(
      (byte) => byte !== 0,
    );
  } catch {
    return false;
  }
};

/**
 * Synced vault documents (docs/internals/vault-sync.md). `sealed:<author>` is
 * that author's newest revision of the item payload under a fresh data key;
 * its AAD binds the item, the author and the field clock SharedState
 * assigned, so a relay cannot replay an old value under a newer clock or
 * another author. `wrap:<recipient>:<by>` holds that data key for one
 * recipient, made by one holder.
 */
export interface VaultSealed {
  readonly v: 1;
  readonly nonce: string;
  readonly ciphertext: string;
}

export interface VaultWrap {
  readonly v: 1;
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
      v: 2,
      itemId,
      author,
      clock: { wall: clock.wall, logical: clock.logical, node: clock.node },
    }),
    "utf8",
  );

/**
 * Sealed plaintexts are padded to a power of two, at least this long, so a
 * relay learns a size bucket rather than the length of a secret.
 */
export const VAULT_PADDED_MINIMUM = 512;

const pad = (plaintext: string): Buffer => {
  const body = Buffer.from(plaintext, "utf8");
  let size = VAULT_PADDED_MINIMUM;
  while (size < body.length + 4) size *= 2;
  const padded = Buffer.alloc(size);
  padded.writeUInt32BE(body.length, 0);
  body.copy(padded, 4);
  return padded;
};

const unpad = (padded: Buffer): string => {
  if (padded.length < 4) throw new Error("Sealed payload is too short.");
  const length = padded.readUInt32BE(0);
  if (length > padded.length - 4) throw new Error("Sealed payload length is out of range.");
  return padded.subarray(4, 4 + length).toString("utf8");
};

export const sealVaultPayload = (input: {
  readonly dataKey: Uint8Array;
  readonly plaintext: string;
  readonly itemId: string;
  readonly author: string;
  readonly clock: VaultSealClock;
}): VaultSealed => {
  const body = aesGcmEncrypt(
    Buffer.from(input.dataKey),
    pad(input.plaintext),
    sealedAad(input.itemId, input.author, input.clock),
  );
  return { v: 1, nonce: body.nonce, ciphertext: body.ciphertext };
};

/** Throws unless `sealed` was made for this item, by `author`, at exactly `clock`. */
export const openVaultPayload = (input: {
  readonly dataKey: Uint8Array;
  readonly sealed: VaultSealed;
  readonly itemId: string;
  readonly author: string;
  readonly clock: VaultSealClock;
}): string =>
  unpad(
    aesGcmDecrypt(
      Buffer.from(input.dataKey),
      { nonce: input.sealed.nonce, ciphertext: input.sealed.ciphertext },
      sealedAad(input.itemId, input.author, input.clock),
    ),
  );

/**
 * What a wrap commits to: one author's revision. Covers every key of the
 * stored value, newer ones included.
 */
export const sealedDigestOf = (author: string, sealed: unknown): string =>
  peerDigest(canonicalPeerJson({ author, sealed }));

/** A key re-encoded from its parsed form, so equal keys bind equal bytes. */
const canonicalPublicKey = (key: NodeCrypto.KeyObject) => encodeKeyObject(key, "public");

const wrapInfo = (input: {
  readonly itemId: string;
  readonly by: string;
  readonly recipient: string;
  readonly sealedDigest: string;
  readonly ephemeralPublicKey: NodeCrypto.KeyObject;
  readonly senderPublicKey: NodeCrypto.KeyObject;
  readonly recipientPublicKey: NodeCrypto.KeyObject;
}) =>
  canonicalPeerJson({
    domain: "cogenly-vault-wrap",
    v: 3,
    itemId: input.itemId,
    by: input.by,
    recipient: input.recipient,
    sealedDigest: input.sealedDigest,
    ephemeralPublicKey: canonicalPublicKey(input.ephemeralPublicKey),
    senderPublicKey: canonicalPublicKey(input.senderPublicKey),
    recipientPublicKey: canonicalPublicKey(input.recipientPublicKey),
  });

/**
 * Authenticated wrap: the key mixes an ephemeral DH with the sender's static
 * DH, so only a holder of `by`'s private key can produce one that verifies.
 * The info, also the AAD, binds all three public keys and both identities.
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
  readonly sealedDigest: string;
  readonly by: string;
  readonly senderPrivateKey: string;
  readonly recipient: string;
  readonly recipientPublicKey: string;
}): VaultWrap => {
  const recipientKey = keyObjectFromRaw(input.recipientPublicKey, "public");
  const senderKey = keyObjectFromRaw(input.senderPrivateKey, "private");
  const ephemeral = NodeCrypto.generateKeyPairSync("x25519");
  const info = wrapInfo({
    itemId: input.itemId,
    by: input.by,
    recipient: input.recipient,
    sealedDigest: input.sealedDigest,
    ephemeralPublicKey: ephemeral.publicKey,
    senderPublicKey: NodeCrypto.createPublicKey(senderKey),
    recipientPublicKey: recipientKey,
  });
  const wrapKey = deriveAuthenticatedWrapKey(
    NodeCrypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientKey }),
    NodeCrypto.diffieHellman({ privateKey: senderKey, publicKey: recipientKey }),
    input.sealedDigest,
    info,
  );
  const encrypted = aesGcmEncrypt(wrapKey, Buffer.from(input.dataKey), Buffer.from(info, "utf8"));
  return {
    v: 1,
    sealedDigest: input.sealedDigest,
    ephemeralPublicKey: encodeKeyObject(ephemeral.publicKey, "public"),
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
  };
};

/**
 * Throws unless the wrap was made for `recipient` by `by`, the holder of
 * `senderPublicKey`, over exactly the revision with `sealedDigest`.
 */
export const unwrapVaultDataKey = (input: {
  readonly wrap: VaultWrap;
  readonly itemId: string;
  readonly sealedDigest: string;
  readonly by: string;
  readonly senderPublicKey: string;
  readonly recipient: string;
  readonly recipientPrivateKey: string;
}): Uint8Array => {
  if (input.wrap.sealedDigest !== input.sealedDigest)
    throw new Error("Wrap is for another revision.");
  const privateKey = keyObjectFromRaw(input.recipientPrivateKey, "private");
  const ephemeralKey = keyObjectFromRaw(input.wrap.ephemeralPublicKey, "public");
  const senderKey = keyObjectFromRaw(input.senderPublicKey, "public");
  const info = wrapInfo({
    itemId: input.itemId,
    by: input.by,
    recipient: input.recipient,
    sealedDigest: input.sealedDigest,
    ephemeralPublicKey: ephemeralKey,
    senderPublicKey: senderKey,
    recipientPublicKey: NodeCrypto.createPublicKey(privateKey),
  });
  const wrapKey = deriveAuthenticatedWrapKey(
    NodeCrypto.diffieHellman({ privateKey, publicKey: ephemeralKey }),
    NodeCrypto.diffieHellman({ privateKey, publicKey: senderKey }),
    input.sealedDigest,
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

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
 * Where this environment's private key lives. Today that is a file in the
 * server secret store; on macOS this seam is where a Keychain-backed store
 * replaces it without touching the crypto above.
 */
export interface VaultMachineKeyStore {
  readonly loadOrCreateKeyPair: () => Promise<VaultKeyPair>;
}

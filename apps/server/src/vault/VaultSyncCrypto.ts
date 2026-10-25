/**
 * Pure cryptography for vault items replicated between paired machines
 * (node:crypto only, no Effect, no I/O). See docs/internals/vault-sync.md.
 *
 * A synced item is one `sealed` body, AES-256-GCM under a fresh data key per
 * revision, plus one wrap of that data key per recipient machine. A wrap is
 * authenticated: its key mixes an ephemeral X25519 exchange with one from the
 * wrapping machine's static vault key, so only a holder of that static key
 * can produce a wrap that verifies as `by` it. A relay that can only encrypt
 * to public keys cannot substitute content.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- node:crypto is the vault primitive.
import * as NodeCrypto from "node:crypto";

import type { HybridClock } from "@t3tools/contracts";

import { canonicalPeerJson, peerDigest } from "../machines/peerCrypto.ts";

export interface SealedVaultItem {
  readonly v: number;
  readonly author: string;
  readonly nonce: string; // base64
  readonly ciphertext: string; // base64, AES-GCM tag appended
}

export interface VaultItemWrap {
  readonly v: number;
  readonly by: string;
  readonly sealedDigest: string;
  readonly ephemeralPublicKey: string; // base64 SPKI DER
  readonly nonce: string; // base64
  readonly ciphertext: string; // base64, AES-GCM tag appended
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const unb64 = (text: string) => Buffer.from(text, "base64");

const publicKeyOf = (encoded: string) =>
  NodeCrypto.createPublicKey({ key: unb64(encoded), format: "der", type: "spki" });
const privateKeyOf = (encoded: string) =>
  NodeCrypto.createPrivateKey({ key: unb64(encoded), format: "der", type: "pkcs8" });

/** True for a canonical base64 X25519 SPKI public key, the only key form a peer may pin. */
export const isX25519PublicKey = (encoded: string): boolean => {
  try {
    const key = publicKeyOf(encoded);
    return (
      key.asymmetricKeyType === "x25519" &&
      b64(key.export({ format: "der", type: "spki" })) === encoded
    );
  } catch {
    return false;
  }
};

const aesGcmEncrypt = (key: Uint8Array, plaintext: Uint8Array, aad: string) => {
  const nonce = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { nonce: b64(nonce), ciphertext: b64(ciphertext) };
};

const aesGcmDecrypt = (
  key: Uint8Array,
  body: { readonly nonce: string; readonly ciphertext: string },
  aad: string,
): Buffer => {
  const nonce = unb64(body.nonce);
  const raw = unb64(body.ciphertext);
  if (nonce.length !== 12 || raw.length < 17) throw new Error("Malformed vault ciphertext.");
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
};

/**
 * The sealed body's AAD binds the field clock SharedState assigned to it, so
 * a relay cannot replay an older body under a newer clock to roll an item back.
 */
const sealedAad = (input: { itemId: string; author: string; clock: HybridClock }) =>
  canonicalPeerJson({
    domain: "cogenly-vault-sealed",
    v: 1,
    itemId: input.itemId,
    author: input.author,
    clock: { wall: input.clock.wall, logical: input.clock.logical, node: input.clock.node },
  });

export const sealVaultItem = (input: {
  readonly dataKey: Uint8Array;
  readonly plaintext: string;
  readonly itemId: string;
  readonly author: string;
  readonly clock: HybridClock;
}): SealedVaultItem => ({
  v: 1,
  author: input.author,
  ...aesGcmEncrypt(input.dataKey, Buffer.from(input.plaintext, "utf8"), sealedAad(input)),
});

/** Throws unless `sealed` was made with `dataKey` for this item, author and clock. */
export const openSealedVaultItem = (input: {
  readonly dataKey: Uint8Array;
  readonly sealed: SealedVaultItem;
  readonly itemId: string;
  readonly clock: HybridClock;
}): string => {
  if (input.sealed.v !== 1) throw new Error("Unsupported sealed vault item version.");
  return aesGcmDecrypt(
    input.dataKey,
    input.sealed,
    sealedAad({ itemId: input.itemId, author: input.sealed.author, clock: input.clock }),
  ).toString("utf8");
};

/** Digest of a sealed value exactly as stored, newer builds' keys included. */
export const sealedVaultDigest = (sealed: unknown): string => peerDigest(canonicalPeerJson(sealed));

const wrapInfo = (input: { itemId: string; by: string; recipient: string }) =>
  canonicalPeerJson({
    domain: "cogenly-vault-wrap",
    v: 2,
    itemId: input.itemId,
    by: input.by,
    recipient: input.recipient,
  });

const wrapKey = (ikm: Buffer, sealedDigest: string, info: string) =>
  Buffer.from(
    NodeCrypto.hkdfSync(
      "sha256",
      ikm,
      Buffer.from(sealedDigest, "base64url"),
      Buffer.from(info, "utf8"),
      32,
    ),
  );

export const wrapVaultDataKey = (input: {
  readonly dataKey: Uint8Array;
  readonly sealed: SealedVaultItem;
  readonly itemId: string;
  readonly by: string;
  readonly senderPrivateKey: string;
  readonly recipient: string;
  readonly recipientPublicKey: string;
}): VaultItemWrap => {
  const recipientKey = publicKeyOf(input.recipientPublicKey);
  const ephemeral = NodeCrypto.generateKeyPairSync("x25519");
  const ikm = Buffer.concat([
    NodeCrypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientKey }),
    NodeCrypto.diffieHellman({
      privateKey: privateKeyOf(input.senderPrivateKey),
      publicKey: recipientKey,
    }),
  ]);
  const sealedDigest = sealedVaultDigest(input.sealed);
  const info = wrapInfo(input);
  return {
    v: 1,
    by: input.by,
    sealedDigest,
    ephemeralPublicKey: b64(ephemeral.publicKey.export({ format: "der", type: "spki" })),
    ...aesGcmEncrypt(wrapKey(ikm, sealedDigest, info), input.dataKey, info),
  };
};

/**
 * Throws unless `wrap` was made for this item and `sealed` value by the holder
 * of `senderPublicKey`'s private key, for `recipient`.
 */
export const unwrapVaultDataKey = (input: {
  readonly wrap: VaultItemWrap;
  readonly sealed: SealedVaultItem;
  readonly itemId: string;
  readonly recipient: string;
  readonly recipientPrivateKey: string;
  readonly senderPublicKey: string;
}): Uint8Array => {
  const sealedDigest = sealedVaultDigest(input.sealed);
  if (input.wrap.v !== 1 || input.wrap.sealedDigest !== sealedDigest)
    throw new Error("Vault wrap does not match this sealed item.");
  const privateKey = privateKeyOf(input.recipientPrivateKey);
  const ikm = Buffer.concat([
    NodeCrypto.diffieHellman({ privateKey, publicKey: publicKeyOf(input.wrap.ephemeralPublicKey) }),
    NodeCrypto.diffieHellman({ privateKey, publicKey: publicKeyOf(input.senderPublicKey) }),
  ]);
  const info = wrapInfo({ itemId: input.itemId, by: input.wrap.by, recipient: input.recipient });
  const dataKey = aesGcmDecrypt(wrapKey(ikm, sealedDigest, info), input.wrap, info);
  if (dataKey.length !== 32) throw new Error("Malformed vault data key.");
  return dataKey;
};

import { describe, expect, it } from "@effect/vitest";

import { generateKeyPair, randomDataKey } from "./VaultCrypto.ts";
import {
  isX25519PublicKey,
  openSealedVaultItem,
  sealVaultItem,
  sealedVaultDigest,
  unwrapVaultDataKey,
  wrapVaultDataKey,
} from "./VaultSyncCrypto.ts";

const itemId = "vault:1";
const clock = { wall: 1_000, logical: 2, node: "env:a" };

const fixture = () => {
  const author = generateKeyPair();
  const recipient = generateKeyPair();
  const dataKey = randomDataKey();
  const sealed = sealVaultItem({
    dataKey,
    plaintext: '{"secretFields":{"password":"hunter2"}}',
    itemId,
    author: "env:a",
    clock,
  });
  const wrap = wrapVaultDataKey({
    dataKey,
    sealed,
    itemId,
    by: "env:a",
    senderPrivateKey: author.privateKey,
    recipient: "env:b",
    recipientPublicKey: recipient.publicKey,
  });
  const unwrap = (overrides: Partial<Parameters<typeof unwrapVaultDataKey>[0]> = {}) =>
    unwrapVaultDataKey({
      wrap,
      sealed,
      itemId,
      recipient: "env:b",
      recipientPrivateKey: recipient.privateKey,
      senderPublicKey: author.publicKey,
      ...overrides,
    });
  return { author, recipient, dataKey, sealed, wrap, unwrap };
};

describe("vault sync crypto", () => {
  it("round-trips a sealed item through an authenticated wrap", () => {
    const { sealed, unwrap, wrap } = fixture();
    expect(wrap.sealedDigest).toBe(sealedVaultDigest(sealed));
    const dataKey = unwrap();
    expect(openSealedVaultItem({ dataKey, sealed, itemId, clock })).toBe(
      '{"secretFields":{"password":"hunter2"}}',
    );
    expect(JSON.stringify({ sealed, wrap })).not.toContain("hunter2");
  });

  it("refuses a tampered body and a body replayed under another clock", () => {
    const { dataKey, sealed } = fixture();
    const raw = Buffer.from(sealed.ciphertext, "base64");
    raw[0] = raw[0]! ^ 1;
    const tampered = { ...sealed, ciphertext: raw.toString("base64") };
    expect(() => openSealedVaultItem({ dataKey, sealed: tampered, itemId, clock })).toThrow();
    // Rollback: an old body presented under a newer field clock.
    expect(() =>
      openSealedVaultItem({ dataKey, sealed, itemId, clock: { ...clock, wall: 2_000 } }),
    ).toThrow();
    expect(() =>
      openSealedVaultItem({ dataKey, sealed: { ...sealed, author: "env:c" }, itemId, clock }),
    ).toThrow();
    expect(() => openSealedVaultItem({ dataKey, sealed, itemId: "vault:2", clock })).toThrow();
  });

  it("refuses a wrap from another sender, for another recipient, or for another body", () => {
    const { author, recipient, dataKey, sealed, unwrap, wrap } = fixture();
    const relay = generateKeyPair();
    // A relay that knows only public keys wraps a key of its own choosing,
    // claiming to be the author.
    const forged = wrapVaultDataKey({
      dataKey: randomDataKey(),
      sealed,
      itemId,
      by: "env:a",
      senderPrivateKey: relay.privateKey,
      recipient: "env:b",
      recipientPublicKey: recipient.publicKey,
    });
    expect(() => unwrap({ wrap: forged })).toThrow();
    expect(() => unwrap({ wrap: { ...wrap, by: "env:c" } })).toThrow();
    expect(() => unwrap({ senderPublicKey: relay.publicKey })).toThrow();
    expect(() => unwrap({ recipient: "env:c" })).toThrow();
    expect(() => unwrap({ recipientPrivateKey: author.privateKey })).toThrow();
    expect(() => unwrap({ itemId: "vault:2" })).toThrow();
    const other = sealVaultItem({ dataKey, plaintext: "{}", itemId, author: "env:a", clock });
    expect(() => unwrap({ sealed: other })).toThrow(/does not match/);
    expect(() => unwrap({ wrap: { ...wrap, sealedDigest: sealedVaultDigest(other) } })).toThrow();
  });

  it("accepts only canonical X25519 SPKI public keys", () => {
    const { publicKey } = generateKeyPair();
    expect(isX25519PublicKey(publicKey)).toBe(true);
    expect(isX25519PublicKey(`${publicKey}AA`)).toBe(false);
    expect(isX25519PublicKey("not a key")).toBe(false);
    expect(isX25519PublicKey(generateKeyPair().privateKey)).toBe(false);
  });
});

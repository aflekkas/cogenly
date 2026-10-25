import { describe, expect, it } from "@effect/vitest";

import {
  decryptBody,
  encryptBody,
  generateKeyPair,
  isX25519PublicKey,
  openVaultPayload,
  randomDataKey,
  sealVaultPayload,
  sealedDigestOf,
  unwrapDataKey,
  unwrapVaultDataKey,
  wrapDataKey,
  wrapVaultDataKey,
  type VaultSealed,
  type VaultWrap,
} from "./VaultCrypto.ts";
import { evaluateVaultPolicy, hostMatchesDomain } from "./VaultPolicy.ts";
import { redactShortSecrets, redactShortValue, redactText, redactValue } from "./VaultRedactor.ts";
import { totp } from "./VaultTotp.ts";

describe("vault crypto", () => {
  it("roundtrips a wrapped data key and an encrypted body", () => {
    const pair = generateKeyPair();
    const dataKey = randomDataKey();
    const wrapped = wrapDataKey({
      recipientPublicKey: pair.publicKey,
      dataKey,
      environmentId: "env:a",
      itemId: "vault:1",
    });
    expect(unwrapDataKey({ wrapped, privateKey: pair.privateKey, itemId: "vault:1" })).toEqual(
      dataKey,
    );
    const body = encryptBody({ dataKey, plaintext: '{"password":"hunter2"}', itemId: "vault:1" });
    expect(decryptBody({ dataKey, body, itemId: "vault:1" })).toBe('{"password":"hunter2"}');
  });

  it("fails on tampered ciphertext, wrong key, wrong environment and wrong item", () => {
    const pair = generateKeyPair();
    const other = generateKeyPair();
    const dataKey = randomDataKey();
    const wrapped = wrapDataKey({
      recipientPublicKey: pair.publicKey,
      dataKey,
      environmentId: "env:a",
      itemId: "vault:1",
    });
    expect(() =>
      unwrapDataKey({ wrapped, privateKey: other.privateKey, itemId: "vault:1" }),
    ).toThrow();
    expect(() =>
      unwrapDataKey({
        wrapped: { ...wrapped, environmentId: "env:b" },
        privateKey: pair.privateKey,
        itemId: "vault:1",
      }),
    ).toThrow();
    expect(() =>
      unwrapDataKey({ wrapped, privateKey: pair.privateKey, itemId: "vault:2" }),
    ).toThrow();
    const body = encryptBody({ dataKey, plaintext: "secret", itemId: "vault:1" });
    const tampered = {
      ...body,
      ciphertext: Buffer.from(
        Buffer.from(body.ciphertext, "base64").map((byte, index) =>
          index === 0 ? byte ^ 1 : byte,
        ),
      ).toString("base64"),
    };
    expect(() => decryptBody({ dataKey, body: tampered, itemId: "vault:1" })).toThrow();
    expect(() => decryptBody({ dataKey: randomDataKey(), body, itemId: "vault:1" })).toThrow();
  });

  it("supports a second machine wrapping the same data key", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const dataKey = randomDataKey();
    const forB = wrapDataKey({
      recipientPublicKey: b.publicKey,
      dataKey,
      environmentId: "env:b",
      itemId: "vault:1",
    });
    expect(unwrapDataKey({ wrapped: forB, privateKey: b.privateKey, itemId: "vault:1" })).toEqual(
      dataKey,
    );
    expect(() =>
      unwrapDataKey({ wrapped: forB, privateKey: a.privateKey, itemId: "vault:1" }),
    ).toThrow();
  });
});

describe("synced vault crypto", () => {
  const author = generateKeyPair();
  const recipient = generateKeyPair();
  const relay = generateKeyPair();
  const clock = { wall: 1_700_000_000_000, logical: 3, node: "env-a" };
  const seal = (
    dataKey = randomDataKey(),
    plaintext = '{"secretFields":{"password":"hunter2"}}',
  ) => {
    const sealed = sealVaultPayload({
      dataKey,
      plaintext,
      itemId: "vault:1",
      author: "env-a",
      clock,
    });
    return { dataKey, sealed, digest: sealedDigestOf("env-a", sealed) };
  };
  const wrapFor = (digest: string, dataKey: Uint8Array, by = "env-a", key = author) =>
    wrapVaultDataKey({
      dataKey,
      itemId: "vault:1",
      sealedDigest: digest,
      by,
      senderPrivateKey: key.privateKey,
      recipient: "env-b",
      recipientPublicKey: recipient.publicKey,
    });
  const unwrap = (wrap: VaultWrap, digest: string, overrides: object = {}) =>
    unwrapVaultDataKey({
      wrap,
      itemId: "vault:1",
      sealedDigest: digest,
      by: "env-a",
      senderPublicKey: author.publicKey,
      recipient: "env-b",
      recipientPrivateKey: recipient.privateKey,
      ...overrides,
    });
  const open = (sealed: VaultSealed, dataKey: Uint8Array, overrides: object = {}) =>
    openVaultPayload({ dataKey, sealed, itemId: "vault:1", author: "env-a", clock, ...overrides });

  it("round trips a sealed payload through an authenticated wrap", () => {
    const { dataKey, sealed, digest } = seal();
    const wrap = wrapFor(digest, dataKey);
    expect(wrap.sealedDigest).toBe(digest);
    const opened = unwrap(wrap, digest);
    expect(opened).toEqual(dataKey);
    expect(open(sealed, opened)).toBe('{"secretFields":{"password":"hunter2"}}');
    expect(JSON.stringify({ sealed, wrap })).not.toContain("hunter2");
  });

  it("refuses tampering, a forged sender, the wrong recipient, another revision and a replayed clock", () => {
    const { dataKey, sealed, digest } = seal();
    const wrap = wrapFor(digest, dataKey);
    const flip = (text: string) =>
      Buffer.from(
        Buffer.from(text, "base64").map((byte, index) => (index === 0 ? byte ^ 1 : byte)),
      ).toString("base64");
    // Tampered sealed ciphertext: its digest no longer matches the wrap, and
    // even with the right data key the body fails authentication.
    const tampered = { ...sealed, ciphertext: flip(sealed.ciphertext) };
    expect(() => unwrap(wrap, sealedDigestOf("env-a", tampered))).toThrow();
    expect(() => open(tampered, dataKey)).toThrow();
    // A relay can encrypt to the recipient but not as the author: its static
    // key does not match the one the recipient trusts for `by`.
    const forged = wrapFor(digest, randomDataKey(), "env-a", relay);
    expect(() => unwrap(forged, digest)).toThrow();
    // Claiming another holder's identity changes the bound info.
    expect(() => unwrap(wrap, digest, { by: "env-c" })).toThrow();
    expect(() => unwrap(wrap, digest, { senderPublicKey: relay.publicKey })).toThrow();
    // Only the named recipient's key opens it, for that recipient id.
    expect(() => unwrap(wrap, digest, { recipientPrivateKey: relay.privateKey })).toThrow();
    expect(() => unwrap(wrap, digest, { recipient: "env-c" })).toThrow();
    // A wrap for one revision does not open another, nor the same value under another author.
    const next = seal();
    expect(() => unwrap(wrap, next.digest)).toThrow();
    expect(() => unwrap({ ...wrap, sealedDigest: next.digest }, next.digest)).toThrow();
    expect(sealedDigestOf("env-c", sealed)).not.toBe(digest);
    // A swapped ephemeral key is bound into the info and fails too.
    expect(() =>
      unwrap({ ...wrap, ephemeralPublicKey: generateKeyPair().publicKey }, digest),
    ).toThrow();
    // Rollback: the same value under a newer clock fails, as do another item and author.
    expect(() => open(sealed, dataKey, { clock: { ...clock, wall: clock.wall + 1 } })).toThrow();
    expect(() => open(sealed, dataKey, { itemId: "vault:2" })).toThrow();
    expect(() => open(sealed, dataKey, { author: "env-c" })).toThrow();
  });

  it("pads sealed plaintext to a size bucket, so short secrets of different lengths look alike", () => {
    const short = seal(randomDataKey(), '{"secretFields":{"password":"a"}}');
    const longer = seal(
      randomDataKey(),
      `{"secretFields":{"password":"${"correct-horse-battery-staple".repeat(4)}"}}`,
    );
    const length = (sealed: VaultSealed) => Buffer.from(sealed.ciphertext, "base64").length;
    expect(length(short.sealed)).toBe(length(longer.sealed));
    expect(length(short.sealed)).toBe(512 + 16);
    const large = seal(randomDataKey(), "x".repeat(600));
    expect(length(large.sealed)).toBe(1024 + 16);
    expect(open(large.sealed, large.dataKey)).toBe("x".repeat(600));
  });

  it("accepts only X25519 SPKI public keys a key exchange accepts", () => {
    expect(isX25519PublicKey(author.publicKey)).toBe(true);
    expect(isX25519PublicKey(author.privateKey)).toBe(false);
    expect(isX25519PublicKey("not a key")).toBe(false);
    // Low-order points parse as X25519 but give no shared secret.
    for (const raw of [
      "0000000000000000000000000000000000000000000000000000000000000000",
      "0100000000000000000000000000000000000000000000000000000000000000",
      "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
      "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    ])
      expect(isX25519PublicKey(lowOrderKey(raw))).toBe(false);
  });
});

/** A low-order X25519 point as a base64 SPKI public key. */
const lowOrderKey = (hex: string) =>
  Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(hex, "hex")]).toString(
    "base64",
  );

describe("totp", () => {
  it("matches RFC 6238 test vectors (SHA1, ascii secret)", () => {
    // Secret "12345678901234567890" as base32.
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(totp(secret, { atMs: 59_000, digits: 8 })).toBe("94287082");
    expect(totp(secret, { atMs: 59_000 })).toBe("287082");
    expect(totp(secret, { atMs: 1_111_111_109_000, digits: 8 })).toBe("07081804");
  });

  it("rejects non-base32 secrets", () => {
    expect(() => totp("not a secret!")).toThrow();
  });
});

describe("domain matching and policy", () => {
  it("matches exact hosts and subdomains only", () => {
    expect(hostMatchesDomain("https://app.example.com/login", "example.com")).toBe(true);
    expect(hostMatchesDomain("example.com:8443", "example.com")).toBe(true);
    expect(hostMatchesDomain("badexample.com", "example.com")).toBe(false);
    expect(hostMatchesDomain("example.com.evil.test", "example.com")).toBe(false);
    expect(hostMatchesDomain("", "example.com")).toBe(false);
  });

  it("allows humans and server callers, asks agents by default", () => {
    const ask = { mode: "ask" as const, allowedAgentIds: [], allowedDomains: [] };
    expect(evaluateVaultPolicy({ policy: ask, caller: { kind: "human" } })).toBe("allow");
    expect(evaluateVaultPolicy({ policy: ask, caller: { kind: "server" } })).toBe("allow");
    expect(evaluateVaultPolicy({ policy: ask, caller: { kind: "agent", agentId: "a1" } })).toBe(
      "ask",
    );
    const allow = {
      mode: "allow" as const,
      allowedAgentIds: ["a1" as never],
      allowedDomains: ["example.com"],
    };
    expect(
      evaluateVaultPolicy({
        policy: allow,
        caller: { kind: "agent", agentId: "a1" },
        domain: "app.example.com",
      }),
    ).toBe("allow");
    expect(
      evaluateVaultPolicy({
        policy: allow,
        caller: { kind: "agent", agentId: "a2" },
        domain: "app.example.com",
      }),
    ).toBe("ask");
    expect(
      evaluateVaultPolicy({
        policy: allow,
        caller: { kind: "agent", agentId: "a1" },
        domain: "other.test",
      }),
    ).toBe("ask");
  });
});

describe("redactor", () => {
  it("replaces stored values length >= 6 everywhere, longest first", () => {
    const secrets = ["hunter2", "hunter2-extended", "abc"];
    expect(redactText("pw is hunter2-extended ok, also hunter2", secrets)).toBe(
      "pw is [redacted vault secret] ok, also [redacted vault secret]",
    );
    expect(redactText("abc stays", secrets)).toBe("abc stays");
    expect(redactValue({ a: ["x hunter2 y"], n: 42 }, secrets)).toEqual({
      a: ["x [redacted vault secret] y"],
      n: 42,
    });
  });

  it("redacts short card secrets only as whole tokens", () => {
    const short = ["987", "08/27"];
    expect(redactShortSecrets("cvc 987, expiry 08/27.", short)).toBe(
      "cvc [redacted vault secret], expiry [redacted vault secret].",
    );
    expect(redactShortSecrets("order 9876 and code 1987 stay", short)).toBe(
      "order 9876 and code 1987 stay",
    );
    expect(redactShortValue({ echoed: ["987"] }, short)).toEqual({
      echoed: ["[redacted vault secret]"],
    });
  });
});

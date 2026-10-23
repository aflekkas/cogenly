import { describe, expect, it } from "@effect/vitest";

import {
  decryptBody,
  encryptBody,
  generateKeyPair,
  randomDataKey,
  unwrapDataKey,
  wrapDataKey,
} from "./VaultCrypto.ts";
import { evaluateVaultPolicy, hostMatchesDomain } from "./VaultPolicy.ts";
import {
  redactShortSecrets,
  redactShortValue,
  redactText,
  redactValue,
  streamRedactor,
} from "./VaultRedactor.ts";
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

  it("allows server callers, asks agents and agent threads by default", () => {
    const ask = { mode: "ask" as const, allowedAgentIds: [], allowedDomains: [] };
    expect(evaluateVaultPolicy({ policy: ask, caller: { kind: "server" } })).toBe("allow");
    expect(evaluateVaultPolicy({ policy: ask, caller: { kind: "agent", agentId: "a1" } })).toBe(
      "ask",
    );
    expect(evaluateVaultPolicy({ policy: ask, caller: { kind: "thread", threadId: "t1" } })).toBe(
      "ask",
    );
    const anyAgent = { mode: "allow" as const, allowedAgentIds: [], allowedDomains: [] };
    expect(
      evaluateVaultPolicy({ policy: anyAgent, caller: { kind: "thread", threadId: "t1" } }),
    ).toBe("allow");
    expect(
      evaluateVaultPolicy({
        policy: { ...anyAgent, allowedAgentIds: ["a1" as never] },
        caller: { kind: "thread", threadId: "t1" },
      }),
    ).toBe("ask");
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

  it("redacts a stream across chunk boundaries, holding only a possible secret", () => {
    const redactor = streamRedactor();
    const sets = { secrets: ["hunter2-long"], shortSecrets: ["987"] };
    expect(redactor.push("pw hunter2", sets)).toBe("pw ");
    expect(redactor.push("-long ok cvc 98", sets)).toBe("[redacted vault secret] ok cvc ");
    // `9876` is a longer number, not the CVC, so it is released as it is.
    expect(redactor.push("76 and 98", sets)).toBe("9876 and ");
    expect(redactor.push("7", sets)).toBe("");
    expect(redactor.push(" end", sets)).toBe("[redacted vault secret] end");
    expect(redactor.push("hun", sets)).toBe("");
    expect(redactor.hasPending()).toBe(true);
    expect(redactor.push("", sets, true)).toBe("hun");
  });

  it("redacts property names too, keeping entries whose names collide", () => {
    expect(
      redactValue({ headers: { "hunter2-a": 1, "hunter2-extended-a": 2, status: 3 } }, [
        "hunter2",
        "hunter2-extended",
      ]),
    ).toEqual({
      headers: {
        "[redacted vault secret]-a": 1,
        "[redacted vault secret]-a#2": 2,
        status: 3,
      },
    });
    expect(redactShortValue({ "987": "cvc" }, ["987"])).toEqual({
      "[redacted vault secret]": "cvc",
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

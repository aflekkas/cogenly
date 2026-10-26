import { describe, expect, it } from "@effect/vitest";

import {
  redactShortValue,
  redactValue,
  streamRedactor,
  type StreamSecrets,
} from "./VaultRedactor.ts";

describe("redactValue", () => {
  it("redacts secrets in object keys as well as values", () => {
    const result = redactValue(
      { "token-value-123": { nested: ["has token-value-123"] }, plain: "ok" },
      ["token-value-123"],
    );
    expect(JSON.stringify(result)).not.toContain("token-value-123");
    expect(result).toMatchObject({ plain: "ok" });
  });

  it("redacts short secrets used as keys, as whole tokens", () => {
    const result = redactShortValue({ "987": "cvc", "9876": "order" }, ["987"]);
    expect(Object.keys(result).sort()).toEqual(["9876", "[redacted vault secret]"]);
  });
});

describe("streamRedactor", () => {
  const run = (secrets: StreamSecrets, chunks: ReadonlyArray<string>) => {
    const redact = streamRedactor(() => secrets);
    return chunks.map((chunk) => redact(chunk)).join("") + redact("", true);
  };
  const set = (secrets: Array<string>, shortSecrets: Array<string> = []): StreamSecrets => ({
    version: 0,
    secrets,
    shortSecrets,
  });

  it("redacts a secret split across chunks without leaking either half", () => {
    const redact = streamRedactor(() => set(["token-value-123"]));
    const first = redact("start token-va");
    expect(first).toBe("start ");
    expect(redact("lue-123 end") + redact("", true)).toBe("[redacted vault secret] end");
  });

  it("matches short secrets only as whole tokens, across chunk edges", () => {
    expect(run(set([], ["pw12"]), ["code pw1", "2 done"])).toBe(
      "code [redacted vault secret] done",
    );
    expect(run(set([], ["pw12"]), ["code pw12", "3 kept"])).toBe("code pw123 kept");
    expect(run(set([], ["pw12"]), ["xpw12 kept"])).toBe("xpw12 kept");
    expect(run(set([], ["pw12"]), ["ends pw12"])).toBe("ends [redacted vault secret]");
  });

  it("prefers the longest secret starting at the same place", () => {
    expect(run(set(["secret-a", "secret-abc"]), ["x secret-abc y"])).toBe(
      "x [redacted vault secret] y",
    );
  });

  it("matches secrets with characters outside the basic plane", () => {
    expect(run(set(["key-🔑-value"]), ["a key-🔑", "-value b"])).toBe(
      "a [redacted vault secret] b",
    );
  });

  it("passes ordinary output through as it arrives", () => {
    const redact = streamRedactor(() => set(["token-value-123"]));
    expect(redact("hello world\n")).toBe("hello world\n");
  });

  it("catches a secret added while the stream runs", () => {
    let secrets = set(["first-value-123"]);
    const redact = streamRedactor(() => secrets);
    expect(redact("later-value-123 ")).toBe("later-value-123 ");
    secrets = { version: 1, secrets: ["first-value-123", "later-value-123"], shortSecrets: [] };
    expect(redact("later-value-123 ") + redact("", true)).toBe("[redacted vault secret] ");
  });
});

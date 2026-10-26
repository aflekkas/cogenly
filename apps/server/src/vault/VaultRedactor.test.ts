import { describe, expect, it } from "@effect/vitest";

import { redactShortValue, redactValue } from "./VaultRedactor.ts";

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

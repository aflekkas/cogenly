import { expect, it } from "@effect/vitest";
import { redactValue, redactShortValue } from "./VaultRedactor.ts";

it("redacts secrets in property names throughout nested output", () => {
  const result = redactShortValue(
    redactValue(
      {
        "token-secret": [{ "auth:password-secret": "token-secret", "123": "ok", "1234": true }],
      },
      ["token-secret", "password-secret"],
    ),
    ["123"],
  );
  expect(result).toEqual({
    "[redacted vault secret]": [
      {
        "auth:[redacted vault secret]": "[redacted vault secret]",
        "[redacted vault secret]": "ok",
        "1234": true,
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("token-secret");
});

import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { expect, it } from "@effect/vitest";
import { redactValue, redactShortValue } from "./VaultRedactor.ts";

const encodeResult = Schema.encodeSync(
  Schema.Struct({
    observedAt: Schema.DateTimeUtcFromString,
    machines: Schema.Array(
      Schema.Struct({ pairedAt: Schema.DateTimeUtcFromString, name: Schema.String }),
    ),
  }),
);

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

it("preserves DateTime values so typed MCP results can encode", () => {
  const at = DateTime.makeUnsafe("2026-10-24T12:00:00.000Z");
  const value = { observedAt: at, machines: [{ pairedAt: at, name: "token-secret" }] };
  const result = redactShortValue(redactValue(value, ["token-secret"]), ["123"]);
  expect(DateTime.isUtc(result.observedAt)).toBe(true);
  expect(result.machines[0]?.pairedAt).toBe(at);
  expect(encodeResult(result)).toEqual({
    observedAt: "2026-10-24T12:00:00.000Z",
    machines: [{ pairedAt: "2026-10-24T12:00:00.000Z", name: "[redacted vault secret]" }],
  });
});

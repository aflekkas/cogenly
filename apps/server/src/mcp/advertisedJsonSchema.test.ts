import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";

const parameters = Schema.Struct({
  count: Schema.optional(Schema.Int),
  clear: Schema.optional(Schema.NullOr(Schema.String)),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
  action: Schema.Union([
    Schema.Struct({ type: Schema.Literal("read"), path: Schema.String }),
    Schema.Struct({ type: Schema.Literal("write"), path: Schema.String, content: Schema.String }),
  ]),
});
const tool = Tool.make("fixture", { parameters, success: Schema.Void });
const decode = Schema.decodeUnknownSync(parameters);

it("compacts codec noise while advertising explicit null clears and meaningful bounds", () => {
  const schema = advertisedJsonSchema(tool);
  expect(schema).toMatchObject({
    type: "object",
    properties: {
      count: { type: "integer" },
      clear: { anyOf: [{ type: "string" }, { type: "null" }] },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      action: {
        type: "object",
        properties: { type: { type: "string", enum: ["read", "write"] } },
        required: ["type", "path"],
      },
    },
    required: ["limit", "action"],
  });
  const json = JSON.stringify(schema);
  expect(json).not.toContain('"additionalProperties":true');
  expect(json).not.toContain(String(Number.MAX_SAFE_INTEGER));
  expect(json).not.toContain(String(Number.MIN_SAFE_INTEGER));
  expect(Buffer.byteLength(json)).toBeLessThan(550);
  expect(Buffer.byteLength(json)).toBeLessThan(
    Buffer.byteLength(JSON.stringify(Tool.getJsonSchema(tool))),
  );
});

it("retains full server validation for omissions, null resets and tagged actions", () => {
  advertisedJsonSchema(tool);
  const input = { limit: 5, action: { type: "read", path: "file" } };
  expect(decode(input)).toEqual(input);
  expect(decode({ ...input, clear: null }).clear).toBeNull();
  expect(() => decode({ ...input, count: null })).toThrow();
  expect(() => decode({ ...input, limit: 51 })).toThrow();
  expect(() => decode({ ...input, action: { type: "write", path: "file" } })).toThrow();
  expect(() => decode({ ...input, action: { type: "other", path: "file" } })).toThrow();
});

import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { RuntimeMode } from "./providerPolicy.ts";
import { Agent } from "./agent.ts";
import { ScheduledTaskFields } from "./scheduledTask.ts";
import { OrchestrationV2ThreadShell } from "./orchestrationV2.ts";

const legacyModes = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
const recordCodecs = [
  RuntimeMode,
  Agent.fields.runtimeMode,
  ScheduledTaskFields.runtimeMode,
  OrchestrationV2ThreadShell.fields.runtimeMode,
].map((schema) => ({
  decode: Schema.decodeUnknownSync(schema),
  encode: Schema.encodeSync(schema),
}));
const decodeRuntimeMode = Schema.decodeUnknownSync(RuntimeMode);

describe("runtime permission compatibility", () => {
  it.each(legacyModes)("normalizes persisted %s records and writes the canonical value", (mode) => {
    for (const { decode, encode } of recordCodecs) {
      expect(decode(mode)).toBe("full-access");
      expect(encode(decode(mode))).toBe("full-access");
    }
  });
  it("rejects unknown modes instead of silently accepting corrupt data", () => {
    expect(() => decodeRuntimeMode("unknown")).toThrow();
  });
});

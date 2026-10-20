import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { RuntimeMode } from "./providerPolicy.ts";
import { Agent } from "./agent.ts";
import { ScheduledTask } from "./scheduledTask.ts";
import { OrchestrationV2ThreadShell } from "./orchestrationV2.ts";

const legacyModes = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;

describe("runtime permission compatibility", () => {
  it.each(legacyModes)("normalizes persisted %s records and writes the canonical value", (mode) => {
    for (const runtimeMode of [
      RuntimeMode,
      Agent.fields.runtimeMode,
      ScheduledTask.fields.runtimeMode,
      OrchestrationV2ThreadShell.fields.runtimeMode,
    ]) {
      expect(Schema.decodeUnknownSync(runtimeMode)(mode)).toBe("full-access");
      expect(Schema.encodeSync(runtimeMode)(Schema.decodeUnknownSync(runtimeMode)(mode))).toBe(
        "full-access",
      );
    }
  });
  it("rejects unknown modes instead of silently accepting corrupt data", () => {
    expect(() => Schema.decodeUnknownSync(RuntimeMode)("unknown")).toThrow();
  });
});

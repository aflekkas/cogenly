import { expect, it } from "@effect/vitest";
import { buildCodexAdditionalContext } from "./CodexDeveloperInstructions.ts";
import { COGENLY_ORCHESTRATION_INSTRUCTIONS } from "@cogenly/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@cogenly/provider-core/server/runtimeInstructions";

it("preserves shared instructions and bounds every availability combination in UTF-8 bytes", () => {
  for (const browser of [false, true]) {
    for (const device of [false, true]) {
      for (const computer of [undefined, "darwin", "linux"]) {
        for (const terminal of [false, true]) {
          const runtime = { model: "gpt-6.1-sol", reasoningEffort: "high" };
          const context = buildCodexAdditionalContext(runtime, {
            browser,
            device,
            ...(computer === undefined ? {} : { computer }),
            terminal,
          });
          const family = (prefix: string) =>
            Object.entries(context)
              .filter(([key]) => key.startsWith(prefix))
              .map(([, entry]) => entry.value)
              .join("");
          expect(family("cogenly_orchestration")).toBe(COGENLY_ORCHESTRATION_INSTRUCTIONS);
          expect(family("cogenly_runtime")).toBe(
            buildRuntimeInstructions({ harness: "Codex", ...runtime }),
          );
          const tools = family("cogenly_tools");
          expect(tools.includes("preview_status")).toBe(browser);
          expect(tools.includes("device_open")).toBe(device);
          expect(tools.includes("computer_press")).toBe(computer === "darwin");
          expect(tools.includes("terminal_run")).toBe(terminal);
          for (const entry of Object.values(context))
            expect(Buffer.byteLength(entry.value)).toBeLessThanOrEqual(4_000);
          expect(
            Object.values(context).reduce((sum, entry) => sum + Buffer.byteLength(entry.value), 0),
          ).toBeLessThan(10_000);
        }
      }
    }
  }
});

it("splits long Unicode runtime labels without losing or corrupting text", () => {
  const runtime = { model: "模型😀".repeat(2_000), reasoningEffort: "high" };
  const context = buildCodexAdditionalContext(runtime, false);
  const combined = Object.entries(context)
    .filter(([key]) => key.startsWith("cogenly_runtime"))
    .map(([, entry]) => entry.value)
    .join("");
  expect(combined).toBe(buildRuntimeInstructions({ harness: "Codex", ...runtime }));
  for (const entry of Object.values(context)) {
    expect(Buffer.byteLength(entry.value)).toBeLessThanOrEqual(4_000);
    expect(Buffer.from(entry.value).toString()).toBe(entry.value);
  }
});

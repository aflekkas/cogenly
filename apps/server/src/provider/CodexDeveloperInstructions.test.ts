import { expect, it } from "@effect/vitest";
import { buildCodexAdditionalContext } from "./CodexDeveloperInstructions.ts";

it("carries the how-Cogenly-works guidance in the runtime context", () => {
  const context = buildCodexAdditionalContext({ model: "gpt-5", reasoningEffort: "high" });
  expect(context.cogenly_runtime?.value).toContain("<how_cogenly_works>");
});

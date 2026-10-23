import { describe, expect, it } from "vite-plus/test";

import {
  GROK_DEFAULT_MODEL,
  grokModelCapabilities,
  grokModelsFromSession,
  resolveGrokReasoningEffort,
} from "./modelCatalog.ts";
import { parseGrokModelState } from "./protocol.ts";

const model = (modelId: string, name: string) => ({
  modelId,
  name,
  contextTokens: undefined,
  efforts: [],
});

describe("grokModelsFromSession", () => {
  it("marks the session's current model as default and drops duplicates", () => {
    const models = grokModelsFromSession({
      currentModelId: "grok-4.7-fast",
      models: [
        model("grok-4.7", "Grok 4.7"),
        model("grok-4.7-fast", "Grok 4.7 Fast"),
        model("grok-4.7", "Duplicate"),
      ],
    });
    expect(models.map((entry) => [entry.slug, entry.isDefault])).toEqual([
      ["grok-4.7", false],
      ["grok-4.7-fast", true],
    ]);
  });

  it("falls back to the documented model when Grok lists none", () => {
    const models = grokModelsFromSession({ currentModelId: undefined, models: [] });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ slug: GROK_DEFAULT_MODEL, isDefault: true });
  });

  it("offers the model's own reasoning tiers, from the 1.0.67 initialize result", () => {
    const [entry] = grokModelsFromSession(
      parseGrokModelState({
        currentModelId: "grok-4.7",
        availableModels: [
          {
            modelId: "grok-4.7",
            name: "Grok 4.7",
            _meta: {
              totalContextTokens: 256000,
              supportsReasoningEffort: true,
              reasoningEffort: "high",
              reasoningEfforts: [
                { id: "xhigh", value: "xhigh", label: "Extra High", default: false },
                { id: "high", value: "high", label: "High", default: true },
                { id: "low", value: "low", label: "Low", default: false },
              ],
            },
          },
        ],
      }),
    );
    const capabilities = entry?.capabilities;
    expect(resolveGrokReasoningEffort(capabilities, undefined)).toBe("high");
    expect(resolveGrokReasoningEffort(capabilities, "xhigh")).toBe("xhigh");
    // A tier this model does not offer falls back to its default.
    expect(resolveGrokReasoningEffort(capabilities, "medium")).toBe("high");
  });

  it("uses Grok's usual tiers when a model reports none", () => {
    expect(resolveGrokReasoningEffort(grokModelCapabilities(), undefined)).toBe("high");
    expect(resolveGrokReasoningEffort(grokModelCapabilities(), "medium")).toBe("medium");
  });
});

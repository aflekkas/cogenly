import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";

import {
  applyModelEffortDefaults,
  buildProviderOptionSelectionsFromDescriptors,
  fillModelSelectionEffortDefault,
  getProviderOptionDescriptors,
  resolveModelEffortDefault,
  withModelEffortDefault,
} from "./model.ts";

const codexCaps: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    },
  ],
};

const claudeCaps: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "effort",
      label: "Effort",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High", isDefault: true },
        { id: "max", label: "Max" },
      ],
    },
    { id: "fastMode", label: "Fast mode", type: "boolean" },
  ],
};

describe("resolveModelEffortDefault", () => {
  it("uses the configured default when the model offers it", () => {
    expect(resolveModelEffortDefault(codexCaps, { id: "reasoningEffort", value: "high" })).toBe(
      "high",
    );
  });

  it("falls back to the catalog default without a configured one", () => {
    expect(resolveModelEffortDefault(codexCaps, undefined)).toBe("medium");
    expect(resolveModelEffortDefault(claudeCaps, null)).toBe("high");
  });

  it("ignores an effort the model does not offer, or another provider's option id", () => {
    expect(resolveModelEffortDefault(codexCaps, { id: "reasoningEffort", value: "xhigh" })).toBe(
      "medium",
    );
    expect(resolveModelEffortDefault(codexCaps, { id: "effort", value: "low" })).toBe("medium");
  });

  it("has nothing to resolve for a model without an effort option", () => {
    expect(
      resolveModelEffortDefault({ optionDescriptors: [] }, { id: "effort", value: "low" }),
    ).toBeUndefined();
  });
});

describe("withModelEffortDefault", () => {
  it("makes the configured effort the one new selections start from", () => {
    const caps = withModelEffortDefault(claudeCaps, { id: "effort", value: "max" });
    const selections = buildProviderOptionSelectionsFromDescriptors(
      getProviderOptionDescriptors({ caps }),
    );
    expect(selections).toContainEqual({ id: "effort", value: "max" });
    const effort = caps.optionDescriptors?.find((descriptor) => descriptor.id === "effort");
    expect(
      effort?.type === "select" && effort.options.filter((option) => option.isDefault),
    ).toEqual([{ id: "max", label: "Max", isDefault: true }]);
  });

  it("leaves capabilities untouched when nothing changes", () => {
    expect(withModelEffortDefault(codexCaps, undefined)).toBe(codexCaps);
    expect(withModelEffortDefault(codexCaps, { id: "reasoningEffort", value: "medium" })).toBe(
      codexCaps,
    );
    expect(withModelEffortDefault(codexCaps, { id: "reasoningEffort", value: "xhigh" })).toBe(
      codexCaps,
    );
  });
});

describe("applyModelEffortDefaults", () => {
  it("applies defaults per model slug and keeps the list when none apply", () => {
    const models = [
      { slug: "gpt", capabilities: codexCaps },
      { slug: "claude", capabilities: claudeCaps },
    ];
    expect(applyModelEffortDefaults(models, undefined)).toBe(models);
    const next = applyModelEffortDefaults(models, { gpt: { id: "reasoningEffort", value: "low" } });
    expect(next[1]).toBe(models[1]);
    expect(resolveModelEffortDefault(next[0]?.capabilities, undefined)).toBe("low");
  });
});

describe("fillModelSelectionEffortDefault", () => {
  const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt" };

  it("fills the configured effort into a selection that names none", () => {
    expect(
      fillModelSelectionEffortDefault(
        { ...selection, options: [{ id: "serviceTier", value: "fast" }] },
        { id: "reasoningEffort", value: "high" },
      ).options,
    ).toEqual([
      { id: "serviceTier", value: "fast" },
      { id: "reasoningEffort", value: "high" },
    ]);
  });

  it("keeps an explicit effort", () => {
    const explicit = { ...selection, options: [{ id: "reasoningEffort", value: "low" }] };
    expect(
      fillModelSelectionEffortDefault(explicit, { id: "reasoningEffort", value: "high" }),
    ).toBe(explicit);
  });
});

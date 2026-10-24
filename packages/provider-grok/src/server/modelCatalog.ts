import {
  GROK_DEFAULT_MODEL,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@cogenly/contracts";
import { createModelCapabilities, getProviderOptionDescriptors } from "@cogenly/shared/model";

import type { GrokModel, GrokModelState, GrokReasoningEffort } from "./protocol.ts";

export { GROK_DEFAULT_MODEL };

/** Grok's own tiers when a model reports none: low to xhigh, high by default. */
const FALLBACK_EFFORTS: ReadonlyArray<GrokReasoningEffort> = [
  { value: "low", label: "Low", description: undefined, isDefault: false },
  { value: "medium", label: "Medium", description: undefined, isDefault: false },
  { value: "high", label: "High", description: undefined, isDefault: true },
  { value: "xhigh", label: "Extra High", description: undefined, isDefault: false },
];

/** The composer's reasoning picker from a model's `_meta.reasoningEfforts`. */
export function grokModelCapabilities(
  efforts?: ReadonlyArray<GrokReasoningEffort>,
): ModelCapabilities {
  const tiers = efforts?.length ? efforts : FALLBACK_EFFORTS;
  const defaultValue = (tiers.find((tier) => tier.isDefault) ?? tiers[0])!.value;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: defaultValue,
        options: tiers.map((tier) => ({
          id: tier.value,
          label: tier.label,
          ...(tier.value === defaultValue ? { isDefault: true } : {}),
          ...(tier.description ? { description: tier.description } : {}),
        })),
      },
    ],
  });
}

/** The tier to send: the saved choice when the model offers it, else its default. */
export function resolveGrokReasoningEffort(
  capabilities: ModelCapabilities | null | undefined,
  effort: string | undefined,
): string | undefined {
  if (!capabilities) return effort;
  const descriptor = getProviderOptionDescriptors({
    caps: capabilities,
    selections: effort ? [{ id: "reasoningEffort", value: effort }] : undefined,
  }).find((candidate) => candidate.id === "reasoningEffort");
  if (descriptor?.type !== "select") return undefined;
  return descriptor.options.find((option) => option.id === descriptor.currentValue)?.id;
}

const toServerModel = (model: GrokModel): ServerProviderModel => ({
  slug: model.modelId,
  name: model.name,
  isCustom: false,
  isDefault: false,
  capabilities: grokModelCapabilities(model.efforts),
});

/**
 * The catalog from Grok's model state; the CLI's current model is the
 * default. Falls back to the documented model when Grok reports none.
 */
export function grokModelsFromSession(state: GrokModelState): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models = state.models.flatMap((model): Array<ServerProviderModel> => {
    if (seen.has(model.modelId)) return [];
    seen.add(model.modelId);
    return [toServerModel(model)];
  });
  const list: ReadonlyArray<ServerProviderModel> = models.length
    ? models
    : [
        toServerModel({
          modelId: GROK_DEFAULT_MODEL,
          name: "Grok 4.7",
          contextTokens: undefined,
          efforts: [],
        }),
      ];
  const defaultSlug =
    list.find((model) => model.slug === state.currentModelId)?.slug ??
    list.find((model) => model.slug === GROK_DEFAULT_MODEL)?.slug ??
    list[0]?.slug;
  return list.map((model) => ({ ...model, isDefault: model.slug === defaultSlug }));
}

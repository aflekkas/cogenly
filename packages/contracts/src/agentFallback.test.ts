import { describe, expect, it } from "@effect/vitest";
import { agentFallbackEntries } from "./agentFallback.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const selection = (instance: string) => ({
  instanceId: ProviderInstanceId.make(instance),
  model: "model",
});
const primary = selection("primary");
const fallback = selection("fallback");
const another = selection("another");
const provider = (entry: typeof primary, driver: string) => ({
  instanceId: entry.instanceId,
  driver: ProviderDriverKind.make(driver),
});

describe("agentFallbackEntries", () => {
  it("preserves order and indices with no catalog or a missing primary", () => {
    for (const catalog of [[], [provider(fallback, "codex")]]) {
      expect(agentFallbackEntries([primary, fallback, another], catalog)).toEqual(
        [primary, fallback, another].map((selection, index) => ({
          selection,
          index,
          skipReason: null,
        })),
      );
    }
  });
  it("keeps unknown instances eligible and skips only provable duplicate accounts", () => {
    const entries = agentFallbackEntries(
      [primary, fallback, another, primary],
      [provider(fallback, "codex"), provider(another, "codex")],
    );
    expect(entries.map((entry) => entry.skipReason)).toEqual([
      null,
      null,
      "same provider account",
      "same provider account",
    ]);
    expect(agentFallbackEntries([primary, primary], []).map((entry) => entry.skipReason)).toEqual([
      null,
      "same provider account",
    ]);
  });
});

import {
  agentFallbackEntries,
  ProviderDriverKind,
  ProviderInstanceId,
  type Agent,
  type ModelSelection,
} from "@cogenly/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  advanceFallback,
  chainIndexOf,
  classifyProviderFailure,
  decideFallback,
  FALLBACK_COOLDOWN_MS,
} from "./providerFallback.ts";

const sel = (instanceId: string, model = "m"): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});
const primary = sel("claude-personal", "opus");
const second = sel("muse", "m");
const third = sel("codex", "gpt-5");
const agent = (over: Partial<Agent> = {}): Agent =>
  ({
    modelSelection: primary,
    fallbackChain: [second, third],
    fallbackIndex: 0,
    fallbackReason: null,
    fallbackUntil: null,
    ...over,
  }) as Agent;
const chain = [primary, second, third];
const providers = chain.map((entry, index) => ({
  instanceId: entry.instanceId,
  driver: ProviderDriverKind.make(["claudeAgent", "muse", "codex"][index]!),
}));
const NOW = Date.parse("2026-01-01T00:00:00.000Z");

describe("classifyProviderFailure", () => {
  it("maps usage_limit and auth signals, and leaves other failures to backoff", () => {
    expect(classifyProviderFailure({ class: "usage_limit", code: null, message: "x" })).toBe(
      "usage_limit",
    );
    expect(
      classifyProviderFailure({ class: "provider_error", code: "api_error_401", message: "x" }),
    ).toBe("auth");
    expect(
      classifyProviderFailure({ class: "provider_error", code: null, message: "Not signed in" }),
    ).toBe("auth");
    expect(
      classifyProviderFailure({ class: "provider_error", code: null, message: "boom" }),
    ).toBeNull();
    expect(
      classifyProviderFailure({ class: "transport_error", code: null, message: "socket closed" }),
    ).toBeNull();
    expect(classifyProviderFailure(null)).toBeNull();
  });
});

describe("decideFallback / advanceFallback", () => {
  it("skips a stored same-provider account without changing its config", () => {
    const school = sel("school", "opus");
    const stored = agent({ fallbackChain: [school, third], fallbackIndex: 1 });
    const catalog = [
      ...providers,
      { instanceId: school.instanceId, driver: ProviderDriverKind.make("claudeAgent") },
    ];
    expect(decideFallback(stored, NOW, catalog)).toMatchObject({ index: 2, selection: third });
    expect(
      advanceFallback({
        chain: [primary, school, third],
        providers: catalog,
        failedIndex: 0,
        reason: "usage_limit",
        resetAt: null,
        nowMs: NOW,
      })?.index,
    ).toBe(2);
    expect(
      advanceFallback({
        chain: [primary, school],
        providers: catalog,
        failedIndex: 0,
        reason: "auth",
        resetAt: null,
        nowMs: NOW,
      }),
    ).toBeNull();
    expect(decideFallback({ ...stored, fallbackChain: [school] }, NOW, catalog)).toMatchObject({
      index: 0,
      selection: primary,
      restored: true,
    });
    expect(stored.fallbackChain).toEqual([school, third]);
    expect(agentFallbackEntries([primary, school, third], catalog)[1]?.skipReason).toBe(
      "same provider account",
    );
    expect(
      advanceFallback({
        chain: [primary, school, third],
        providers: [],
        failedIndex: 0,
        reason: "usage_limit",
        resetAt: null,
        nowMs: NOW,
      }),
    ).toBeNull();
  });
  it("uses the primary entry with no stored fallback, and without a chain", () => {
    expect(decideFallback(agent(), NOW, providers)).toMatchObject({
      index: 0,
      selection: primary,
      restored: false,
    });
    expect(
      decideFallback(agent({ fallbackChain: [], fallbackIndex: 1 }), NOW, providers).index,
    ).toBe(0);
    expect(
      advanceFallback({
        chain: [primary],
        providers,
        failedIndex: 0,
        reason: "usage_limit",
        resetAt: null,
        nowMs: NOW,
      }),
    ).toBeNull();
    expect(
      advanceFallback({
        chain,
        providers,
        failedIndex: 0,
        reason: null,
        resetAt: null,
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("advances to the next entry and returns to primary at the known reset", () => {
    const reset = "2026-01-01T10:00:00.000Z";
    const advance = advanceFallback({
      chain,
      providers,
      failedIndex: 0,
      reason: "usage_limit",
      resetAt: reset,
      nowMs: NOW,
    });
    expect(advance).toEqual({ index: 1, reason: "usage_limit", until: reset, resetAt: reset });
    const fallen = agent({
      fallbackIndex: advance!.index,
      fallbackReason: "usage_limit",
      fallbackUntil: advance!.until,
    });
    expect(decideFallback(fallen, NOW + 1000, providers)).toMatchObject({
      index: 1,
      selection: second,
      reason: "usage_limit",
    });
    expect(decideFallback(fallen, Date.parse(reset), providers)).toMatchObject({
      index: 0,
      selection: primary,
      restored: true,
    });
  });

  it("uses the cooldown when no reset is known, and stays on the last entry when exhausted", () => {
    const advance = advanceFallback({
      chain,
      providers,
      failedIndex: 0,
      reason: "auth",
      resetAt: null,
      nowMs: NOW,
    });
    expect(advance!.until).toBe("2026-01-01T01:00:00.000Z");
    expect(Date.parse(advance!.until) - NOW).toBe(FALLBACK_COOLDOWN_MS);
    expect(advance!.resetAt).toBeNull();
    expect(
      advanceFallback({
        chain,
        providers,
        failedIndex: 2,
        reason: "auth",
        resetAt: null,
        nowMs: NOW,
      })!.index,
    ).toBe(2);
    const exhausted = agent({
      fallbackIndex: 2,
      fallbackReason: "auth",
      fallbackUntil: advance!.until,
    });
    expect(decideFallback(exhausted, NOW + FALLBACK_COOLDOWN_MS, providers).restored).toBe(true);
  });

  it("keeps the return-to-primary time set by the primary failure when a fallback fails", () => {
    const primaryUntil = "2026-01-01T10:00:00.000Z";
    // A fallback failing much later, with its own later reset, must not
    // push out when the primary is retried.
    const advance = advanceFallback({
      chain,
      providers,
      failedIndex: 1,
      reason: "usage_limit",
      resetAt: "2026-01-05T10:00:00.000Z",
      nowMs: Date.parse("2026-01-03T00:00:00.000Z"),
      existingUntil: primaryUntil,
    });
    expect(advance).toEqual({
      index: 2,
      reason: "usage_limit",
      until: primaryUntil,
      resetAt: null,
    });
    // And without a known reset it must not start a fresh cooldown either.
    expect(
      advanceFallback({
        chain,
        providers,
        failedIndex: 2,
        reason: "auth",
        resetAt: null,
        nowMs: Date.parse("2026-01-03T00:00:00.000Z"),
        existingUntil: primaryUntil,
      })!.until,
    ).toBe(primaryUntil);
  });

  it("finds the used entry in the chain", () => {
    expect(chainIndexOf([primary, second, third], third)).toBe(2);
    expect(chainIndexOf([primary, second], undefined)).toBe(0);
    expect(chainIndexOf([primary, second], sel("unknown"))).toBe(0);
  });
});

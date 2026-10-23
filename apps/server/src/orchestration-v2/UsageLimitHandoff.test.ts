import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  providerUsageHeadroom,
  rankUsageLimitHandoffCandidates,
  USAGE_STALE_AFTER_MS,
} from "./UsageLimitHandoff.ts";

const now = Date.parse("2026-10-23T12:00:00.000Z");
const later = "2026-10-23T15:00:00.000Z";

function limits(
  windows: ServerProviderUsageLimits["windows"],
  checkedAt = "2026-10-23T11:55:00.000Z",
): ServerProviderUsageLimits {
  return { checkedAt, windows };
}

const session = (usedPercent: number, resetsAt: string | undefined = later) => ({
  id: "five_hour",
  kind: "session" as const,
  label: "Session",
  usedPercent,
  ...(resetsAt === undefined ? {} : { resetsAt }),
});

function model(slug: string, extra: Partial<ServerProvider["models"][number]> = {}) {
  return { slug, name: slug, isCustom: false, capabilities: null, ...extra };
}

function provider(
  instanceId: string,
  driver: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: `${instanceId}@example.com` },
    checkedAt: "2026-10-23T11:00:00.000Z",
    models: [model("claude-opus-4-5", { isDefault: true }), model("claude-sonnet-4-5")],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const from: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-5",
  options: [{ id: "effort", value: "high" }],
};

const rank = (providers: ReadonlyArray<ServerProvider>) =>
  rankUsageLimitHandoffCandidates({ providers, from, nowMs: now }).map(
    (candidate) => candidate.instanceId,
  );

describe("providerUsageHeadroom", () => {
  it("reports the tightest window as the remaining headroom", () => {
    const headroom = providerUsageHeadroom(
      limits([session(30), { ...session(85), id: "seven_day", kind: "weekly", label: "Weekly" }]),
      now,
    );
    expect(headroom).toMatchObject({ state: "available", remainingPercent: 15, stale: false });
    expect(headroom.windows).toEqual([
      { label: "Session", kind: "session", usedPercent: 30, resetsAt: later },
      { label: "Weekly", kind: "weekly", usedPercent: 85, resetsAt: later },
    ]);
  });

  it("marks a full window exhausted until its reset, and fresh after it", () => {
    expect(providerUsageHeadroom(limits([session(100)]), now).state).toBe("exhausted");
    const reset = providerUsageHeadroom(limits([session(100, "2026-10-23T11:00:00.000Z")]), now);
    expect(reset).toMatchObject({ state: "available", remainingPercent: 100 });
    expect(reset.windows[0]).not.toHaveProperty("resetsAt");
  });

  it("is unknown without a readable window, and flags old readings as stale", () => {
    expect(providerUsageHeadroom(undefined, now)).toMatchObject({
      state: "unknown",
      checkedAt: null,
      stale: false,
    });
    expect(
      providerUsageHeadroom({ ...limits([]), unavailable: { reason: "probeFailed" } }, now).state,
    ).toBe("unknown");
    const old = DateTime.formatIso(DateTime.makeUnsafe(now - USAGE_STALE_AFTER_MS - 1));
    expect(providerUsageHeadroom(limits([session(10)], old), now).stale).toBe(true);
  });
});

describe("rankUsageLimitHandoffCandidates", () => {
  const source = provider("claudeAgent", "claudeAgent", { usageLimits: limits([session(100)]) });

  it("puts known headroom before unknown and leaves exhausted instances out", () => {
    expect(
      rank([
        source,
        provider("claude-unknown", "claudeAgent"),
        provider("claude-full", "claudeAgent", { usageLimits: limits([session(100)]) }),
        provider("claude-room", "claudeAgent", { usageLimits: limits([session(20)]) }),
      ]),
    ).toEqual(["claude-room", "claude-unknown"]);
  });

  it("prefers the same driver, then the same model, then the most remaining", () => {
    expect(
      rank([
        source,
        provider("codex", "codex", {
          models: [model("gpt-5")],
          usageLimits: limits([session(0)]),
        }),
        provider("claude-other-model", "claudeAgent", {
          models: [model("claude-opus-4-5")],
          usageLimits: limits([session(10)]),
        }),
        provider("claude-busy", "claudeAgent", { usageLimits: limits([session(70)]) }),
        provider("claude-idle", "claudeAgent", { usageLimits: limits([session(5)]) }),
      ]),
    ).toEqual(["claude-idle", "claude-busy", "claude-other-model", "codex"]);
  });

  it("tries another account on the same driver before another driver with known room", () => {
    expect(
      rank([
        source,
        provider("codex", "codex", { models: [model("gpt-5")], usageLimits: limits([session(0)]) }),
        provider("claude-unknown", "claudeAgent"),
      ]),
    ).toEqual(["claude-unknown", "codex"]);
  });

  it("skips instances on the stopped account and ones that cannot run turns", () => {
    expect(
      rank([
        source,
        provider("same-account", "claudeAgent", {
          auth: { status: "authenticated", email: "CLAUDEAGENT@example.com" },
        }),
        provider("signed-out", "claudeAgent", { auth: { status: "unauthenticated" } }),
        provider("disabled", "claudeAgent", { enabled: false }),
        provider("errored", "claudeAgent", { status: "error" }),
        provider("ok", "claudeAgent"),
      ]),
    ).toEqual(["ok"]);
  });

  it("keeps the model and its options on the same driver, and falls back to the default elsewhere", () => {
    const [same, other] = rankUsageLimitHandoffCandidates({
      providers: [
        source,
        provider("claude-personal", "claudeAgent", { usageLimits: limits([session(10)]) }),
        provider("codex", "codex", {
          models: [model("gpt-5-mini"), model("gpt-5", { isDefault: true })],
          usageLimits: limits([session(10)]),
        }),
      ],
      from,
      nowMs: now,
    });
    expect(same?.modelSelection).toEqual({
      instanceId: "claude-personal",
      model: "claude-sonnet-4-5",
      options: [{ id: "effort", value: "high" }],
    });
    expect(same).toMatchObject({ sameDriver: true, sameModel: true });
    expect(other?.modelSelection).toEqual({ instanceId: "codex", model: "gpt-5" });
    expect(other).toMatchObject({ sameDriver: false, sameModel: false });
  });

  it("does not fall back to a model the user hid", () => {
    const [candidate] = rankUsageLimitHandoffCandidates({
      providers: [
        source,
        provider("codex", "codex", {
          models: [model("gpt-5", { isDefault: true }), model("gpt-5-mini")],
        }),
      ],
      from,
      nowMs: now,
      hiddenModels: { codex: ["gpt-5"] },
    });
    expect(candidate?.modelSelection.model).toBe("gpt-5-mini");
  });
});

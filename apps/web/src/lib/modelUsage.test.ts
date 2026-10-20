import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  addModelUse,
  mergeModelUsage,
  pickRecentModels,
  rankModelUsage,
  threadModelUses,
} from "./modelUsage";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-20T12:00:00.000Z");

describe("rankModelUsage", () => {
  it("ranks frequent recent use above a single newer use", () => {
    let entries = addModelUse([], "codex", "gpt", NOW - 2 * DAY);
    entries = addModelUse(entries, "codex", "gpt", NOW - DAY);
    entries = addModelUse(entries, "codex", "gpt", NOW - DAY / 2);
    entries = addModelUse(entries, "claude", "opus", NOW - 1000);
    expect(rankModelUsage(entries, NOW).map((entry) => entry.model)).toEqual(["gpt", "opus"]);
  });

  it("lets old heavy use fade below recent use", () => {
    let entries = addModelUse([], "codex", "gpt", NOW - 30 * DAY);
    entries = addModelUse(entries, "codex", "gpt", NOW - 29 * DAY);
    entries = addModelUse(entries, "codex", "gpt", NOW - 28 * DAY);
    entries = addModelUse(entries, "claude", "opus", NOW - DAY);
    expect(rankModelUsage(entries, NOW).map((entry) => entry.model)).toEqual(["opus", "gpt"]);
  });
});

describe("addModelUse", () => {
  it("counts a pick and the send right after it as one use", () => {
    const picked = addModelUse([], "codex", "gpt", NOW);
    expect(addModelUse(picked, "codex", "gpt", NOW + 5000)).toBe(picked);
    expect(addModelUse(picked, "codex", "gpt", NOW + 2 * 60 * 1000)[0]?.uses).toHaveLength(2);
  });

  it("keeps the same model on two providers apart", () => {
    const entries = addModelUse(addModelUse([], "codex", "gpt", NOW), "codex-work", "gpt", NOW);
    expect(entries).toHaveLength(2);
  });
});

const MODELS = [
  { instanceId: "codex", slug: "gpt-6.1-sol" },
  { instanceId: "claudeAgent", slug: "claude-opus-5-5" },
  { instanceId: "muse", slug: "muse-wonder-1.0" },
];

describe("Recent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("appears once a model is sent with or picked", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    const usage = await import("./modelUsage");
    expect(usage.pickRecentModels(MODELS, usage.readModelUsage(), Date.now(), 5)).toEqual([]);

    usage.recordModelUsage("muse", "muse-wonder-1.0");
    usage.recordModelUsage("claudeAgent", "claude-opus-5-5");

    const recent = usage.pickRecentModels(MODELS, usage.readModelUsage(), Date.now(), 5);
    expect(recent.map((model) => model.slug).toSorted()).toEqual([
      "claude-opus-5-5",
      "muse-wonder-1.0",
    ]);
    // It survives a reload of the page.
    vi.resetModules();
    const reloaded = await import("./modelUsage");
    expect(reloaded.readModelUsage()).toHaveLength(2);
  });

  it("is seeded from the threads the user wrote in", () => {
    const fromThreads = threadModelUses([
      {
        modelSelection: { instanceId: "muse", model: "muse-wonder-1.0" },
        lastUserMessageAt: new Date(NOW - 1000).toISOString(),
      },
      {
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        lastUserMessageAt: new Date(NOW - DAY).toISOString(),
      },
      {
        modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
        lastUserMessageAt: null,
      },
    ]);
    expect(pickRecentModels(MODELS, mergeModelUsage([], fromThreads), NOW, 5)).toEqual([
      MODELS[2],
      MODELS[1],
    ]);
  });

  it("skips models the picker cannot offer", () => {
    const entries = addModelUse([], "gone", "old-model", NOW);
    expect(pickRecentModels(MODELS, entries, NOW, 5)).toEqual([]);
  });

  it("counts a send recorded here and seen on its thread once", () => {
    const recorded = addModelUse([], "muse", "muse-wonder-1.0", NOW);
    const fromThreads = threadModelUses([
      {
        modelSelection: { instanceId: "muse", model: "muse-wonder-1.0" },
        lastUserMessageAt: new Date(NOW + 2000).toISOString(),
      },
    ]);
    expect(mergeModelUsage(recorded, fromThreads)[0]?.uses).toHaveLength(1);
  });
});

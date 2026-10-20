import { describe, expect, it } from "vite-plus/test";

import { addModelUse, rankModelUsage } from "./modelUsage";

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

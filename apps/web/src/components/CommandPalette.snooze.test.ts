import { describe, expect, it } from "vite-plus/test";

import { buildSnoozeGroups } from "./CommandPalette.snooze";

const now = new Date(2026, 9, 22, 14, 19);
const snoozed: Array<string> = [];
const rows = (query: string) =>
  buildSnoozeGroups({
    query,
    now,
    timestampFormat: "locale",
    icon: null,
    snooze: async (snoozedUntil) => {
      snoozed.push(snoozedUntil);
    },
  })[0]!.items;

describe("buildSnoozeGroups", () => {
  it("leads with a typed time and snoozes until it", async () => {
    const [first] = rows("in 2 days");
    expect(first?.value).toBe("snooze:typed");
    expect(String(first?.title)).toMatch(/^Snooze until /);
    if (first?.kind !== "action") throw new Error("expected an action row");
    await first.run();
    expect(snoozed.at(-1)).toBe(new Date(2026, 9, 24, 14, 19).toISOString());
  });

  it("leaves a phrase the presets already offer to the preset row", () => {
    expect(rows("tmrw").map((row) => row.value)).not.toContain("snooze:typed");
    expect(rows("tomorrow").map((row) => row.value)).not.toContain("snooze:typed");
  });

  it("offers only the presets for an empty or unreadable query", () => {
    for (const query of ["", "banana"]) {
      expect(rows(query).map((row) => row.value)).toEqual([
        "snooze:hour",
        "snooze:three-hours",
        "snooze:evening",
        "snooze:tomorrow",
        "snooze:next-week",
      ]);
    }
  });
});

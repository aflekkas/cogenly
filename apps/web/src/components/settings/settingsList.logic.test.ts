import { describe, expect, it } from "vite-plus/test";

import {
  groupRepeatedEntries,
  matchesSettingsListQuery,
  settingsSearchEscapeClears,
} from "./settingsList.logic";

describe("settings list search", () => {
  it("Escape clears a query before it can leave Settings", () => {
    const escape = { key: "Escape", isComposing: false };
    expect(settingsSearchEscapeClears(escape, "deploy")).toBe(true);
    expect(settingsSearchEscapeClears(escape, " ")).toBe(true);
    // Nothing to clear: Escape goes on to the page.
    expect(settingsSearchEscapeClears(escape, "")).toBe(false);
  });

  it("leaves other keys and an IME's Escape alone", () => {
    expect(settingsSearchEscapeClears({ key: "Enter", isComposing: false }, "deploy")).toBe(false);
    expect(settingsSearchEscapeClears({ key: "Escape", isComposing: true }, "deploy")).toBe(false);
  });

  it("finds a name or description regardless of case and surrounding query whitespace", () => {
    expect(
      matchesSettingsListQuery("  deploy  ", ["Nightly release", "Deploy the web client"]),
    ).toBe(true);
    expect(matchesSettingsListQuery("RELEASE", ["Nightly release", null])).toBe(true);
    expect(matchesSettingsListQuery("release", [undefined, "Other task"])).toBe(false);
  });

  it("clearing a search includes entries that have no description", () => {
    expect(matchesSettingsListQuery("   ", [null, undefined])).toBe(true);
  });
});

describe("repeated list entries", () => {
  it("keeps the latest of each repeat in place and counts the rest", () => {
    const failures = [
      { name: "github.fetch", cause: "offline", at: 3 },
      { name: "sync", cause: "timeout", at: 2 },
      { name: "github.fetch", cause: "offline", at: 1 },
      { name: "github.fetch", cause: "rate limited", at: 0 },
    ];
    expect(
      groupRepeatedEntries(failures, (failure) => `${failure.name}\n${failure.cause}`),
    ).toEqual([
      { entry: failures[0], count: 2, occurrences: [failures[0], failures[2]] },
      { entry: failures[1], count: 1, occurrences: [failures[1]] },
      { entry: failures[3], count: 1, occurrences: [failures[3]] },
    ]);
  });

  it("keeps every folded occurrence, newest first, so each trace stays reachable", () => {
    const logs = [
      { message: "offline", traceId: "c", at: 3 },
      { message: "offline", traceId: "b", at: 2 },
      { message: "offline", traceId: "a", at: 1 },
    ];
    const [group] = groupRepeatedEntries(logs, (log) => log.message);
    expect(group?.count).toBe(3);
    expect(group?.occurrences.map((log) => log.traceId)).toEqual(["c", "b", "a"]);
  });
});

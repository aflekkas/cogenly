import { describe, expect, it } from "vite-plus/test";

import { groupRepeatedEntries, matchesSettingsListQuery } from "./settingsList.logic";

describe("settings list search", () => {
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
      { entry: failures[0], count: 2 },
      { entry: failures[1], count: 1 },
      { entry: failures[3], count: 1 },
    ]);
  });
});

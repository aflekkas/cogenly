import { describe, expect, it } from "vite-plus/test";

import { matchesSettingsListQuery } from "./settingsList.logic";

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

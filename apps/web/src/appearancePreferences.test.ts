import { describe, expect, it } from "vite-plus/test";

import {
  appearanceRootAttributes,
  DEFAULT_APPEARANCE_PREFERENCES,
  parseAppearancePreferences,
} from "./appearancePreferences";

describe("parseAppearancePreferences", () => {
  it("defaults when nothing is stored or the value is not JSON", () => {
    expect(parseAppearancePreferences(null)).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
    expect(parseAppearancePreferences("{nope")).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
    expect(parseAppearancePreferences("null")).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
  });

  it("keeps valid fields and falls back per field for unknown ones", () => {
    expect(
      parseAppearancePreferences(
        JSON.stringify({ accent: "blue", fontSize: "huge", motion: "reduce" }),
      ),
    ).toEqual({ accent: "blue", fontSize: "default", motion: "reduce" });
    expect(parseAppearancePreferences(JSON.stringify({ accent: "#3b82f6" })).accent).toBe("orange");
  });
});

describe("appearanceRootAttributes", () => {
  it("sets no attributes for the defaults", () => {
    expect(appearanceRootAttributes(DEFAULT_APPEARANCE_PREFERENCES)).toEqual({
      "data-accent": null,
      "data-font-size": null,
      "data-reduce-motion": null,
    });
  });

  it("marks a chosen accent, font size and reduced motion", () => {
    expect(
      appearanceRootAttributes({ accent: "teal", fontSize: "large", motion: "reduce" }),
    ).toEqual({
      "data-accent": "teal",
      "data-font-size": "large",
      "data-reduce-motion": "",
    });
  });
});

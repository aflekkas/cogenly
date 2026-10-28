import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  appearanceRootAttributes,
  DEFAULT_APPEARANCE_PREFERENCES,
  parseAppearancePreferences,
  readReducedMotion,
} from "./appearancePreferences";

describe("readReducedMotion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubWindow = (motion: "system" | "reduce", systemReduces: boolean) =>
    vi.stubGlobal("window", {
      localStorage: { getItem: () => JSON.stringify({ motion }) },
      matchMedia: () => ({ matches: systemReduces }),
    });

  it("follows the app's Reduce motion while the OS asks for full motion", () => {
    stubWindow("reduce", false);
    expect(readReducedMotion()).toBe(true);
  });

  it("follows the OS setting when the app follows the system", () => {
    stubWindow("system", true);
    expect(readReducedMotion()).toBe(true);
    stubWindow("system", false);
    expect(readReducedMotion()).toBe(false);
  });
});

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
    ).toEqual({
      accent: "blue",
      fontSize: "default",
      motion: "reduce",
      usageMeter: "remaining",
      sidebarLayout: "bottom",
    });
    expect(parseAppearancePreferences(JSON.stringify({ accent: "#3b82f6" })).accent).toBe("orange");
  });

  it("reads the usage meter mode and ignores unknown ones", () => {
    expect(parseAppearancePreferences(JSON.stringify({ usageMeter: "used" })).usageMeter).toBe(
      "used",
    );
    expect(parseAppearancePreferences(JSON.stringify({ usageMeter: "spent" })).usageMeter).toBe(
      "remaining",
    );
  });

  it("reads the sidebar layout, bottom unless top is chosen", () => {
    expect(parseAppearancePreferences(JSON.stringify({ sidebarLayout: "top" })).sidebarLayout).toBe(
      "top",
    );
    expect(
      parseAppearancePreferences(JSON.stringify({ sidebarLayout: "left" })).sidebarLayout,
    ).toBe("bottom");
    expect(parseAppearancePreferences(JSON.stringify({ accent: "blue" })).sidebarLayout).toBe(
      "bottom",
    );
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
      appearanceRootAttributes({
        accent: "teal",
        fontSize: "large",
        motion: "reduce",
        usageMeter: "used",
        sidebarLayout: "bottom",
      }),
    ).toEqual({
      "data-accent": "teal",
      "data-font-size": "large",
      "data-reduce-motion": "",
    });
  });
});

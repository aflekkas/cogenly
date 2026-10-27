import { describe, expect, it } from "@effect/vitest";

import { summarizeManifest } from "./BrowserExtensionManifest.ts";

const base = { manifest_version: 3, name: "Example", version: "1.0.0" };

describe("extension manifest metadata", () => {
  it("prefers the 32px action icon over manifest icons", () => {
    expect(
      summarizeManifest({
        ...base,
        action: { default_icon: { "16": "small.png", "32": "toolbar.png", "128": "large.png" } },
        icons: { "32": "manifest.png" },
        side_panel: { default_path: "/panel.html" },
      }),
    ).toMatchObject({ iconPath: "toolbar.png", hasAction: true, sidePanelPage: "panel.html" });
  });

  it("uses the nearest size and accepts a string action icon", () => {
    expect(
      summarizeManifest({
        ...base,
        icons: { "16": "small.png", "48": "medium.png", "128": "large.png" },
      }).iconPath,
    ).toBe("medium.png");
    expect(summarizeManifest({ ...base, action: { default_icon: "toolbar.png" } }).iconPath).toBe(
      "toolbar.png",
    );
  });

  it("reads MV2 browser_action and distinguishes an action without a popup", () => {
    expect(
      summarizeManifest({
        ...base,
        manifest_version: 2,
        browser_action: { default_popup: "/legacy.html", default_icon: { "32": "legacy.png" } },
      }),
    ).toMatchObject({ hasAction: true, popupPage: "legacy.html", iconPath: "legacy.png" });
    expect(summarizeManifest({ ...base, action: {} })).toMatchObject({ hasAction: true });
    expect(summarizeManifest(base)).toMatchObject({ hasAction: false });
  });
});

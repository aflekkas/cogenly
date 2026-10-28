import { describe, expect, it } from "vite-plus/test";

import { clampedPreviewText, compactPathHint } from "./settingsText.logic";

describe("folder path placeholders", () => {
  it("keeps the folders that tell a long path apart", () => {
    expect(
      compactPathHint("/Users/sam/.cogenly/worktrees/cogenly/feature-a/.cogenly/projects"),
    ).toBe("~/…/.cogenly/projects");
    expect(compactPathHint("/srv/data/cogenly/state/projects")).toBe("/…/state/projects");
  });

  it("leaves a short path whole, with home as ~", () => {
    expect(compactPathHint("/home/sam/.cogenly/projects")).toBe("~/.cogenly/projects");
    expect(compactPathHint("~/")).toBe("~/");
    expect(compactPathHint("<Cogenly home>/projects")).toBe("<Cogenly home>/projects");
  });
});

describe("clamped text previews", () => {
  it("starts a pretty-printed JSON payload's preview on its first content", () => {
    const payload = JSON.stringify([{ message: "Fetch failed", code: 502 }], null, 2);
    expect(clampedPreviewText(payload).split("\n")[0]).toBe('[{"message": "Fetch failed",');
  });

  it("leaves ordinary text alone", () => {
    expect(clampedPreviewText("Fetch failed: [502] upstream")).toBe("Fetch failed: [502] upstream");
    expect(clampedPreviewText("line one\n  line two")).toBe("line one\n  line two");
  });
});

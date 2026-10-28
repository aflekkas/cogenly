import { describe, expect, it } from "vite-plus/test";

import {
  clampedPreviewText,
  cliVersionLabel,
  compactPathHint,
  readableLogMessage,
} from "./settingsText.logic";

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

describe("CLI versions", () => {
  it("keeps only the version number", () => {
    expect(cliVersionLabel("gh version 2.96.0 (2026-07-02)")).toBe("v2.96.0");
    expect(cliVersionLabel("git version 2.50.1 (Apple Git-155)")).toBe("v2.50.1");
    expect(cliVersionLabel("jj 0.31")).toBe("v0.31");
  });

  it("leaves output without a version alone", () => {
    expect(cliVersionLabel("unknown build\n")).toBe("unknown build");
  });
});

describe("logged messages", () => {
  it("reads a message and its cause as one line", () => {
    const payload = JSON.stringify(
      ["Failed to read history", { cause: "Monitor binary was not found" }],
      null,
      2,
    );
    expect(readableLogMessage(payload)).toBe(
      "Failed to read history: Monitor binary was not found",
    );
    expect(readableLogMessage('["Failed to read history"]')).toBe("Failed to read history");
  });

  it("keeps payloads it can't fold without losing fields", () => {
    const extra = JSON.stringify(["Failed", { cause: "Timeout", attempt: 3 }]);
    expect(readableLogMessage(extra)).toBe(extra);
    expect(readableLogMessage('[{"cause": "Timeout"}]')).toBe('[{"cause": "Timeout"}]');
    expect(readableLogMessage("[502] upstream failed")).toBe("[502] upstream failed");
  });
});

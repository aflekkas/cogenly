import { describe, expect, it } from "@effect/vitest";

import { quietReasoningMarkdown, reasoningPlainText } from "./reasoningText.ts";

describe("quietReasoningMarkdown", () => {
  it("drops Codex bold section headings and markdown headings", () => {
    expect(
      quietReasoningMarkdown(
        "**Locating the relevant chat**\n\nI'll search.\n\n## Checking chat history\nDone.",
      ),
    ).toBe("Locating the relevant chat\n\nI'll search.\n\nChecking chat history\nDone.");
  });

  it("keeps inline code, links, lists and fenced code as written", () => {
    const markdown = [
      "- read `**not bold**` in [the docs](https://example.com) __now__",
      "```ts",
      "const x = **y**;",
      "# not a heading",
      "```",
    ].join("\n");
    expect(quietReasoningMarkdown(markdown)).toBe(
      [
        "- read `**not bold**` in [the docs](https://example.com) now",
        "```ts",
        "const x = **y**;",
        "# not a heading",
        "```",
      ].join("\n"),
    );
  });

  it("removes setext heading underlines", () => {
    expect(quietReasoningMarkdown("Plan\n====\nStep")).toBe("Plan\n\nStep");
  });
});

describe("reasoningPlainText", () => {
  it("reads a reasoning summary as one plain line", () => {
    expect(reasoningPlainText("**Running AI funding searches**\n\nUsing `search`.")).toBe(
      "Running AI funding searches Using search.",
    );
  });
});

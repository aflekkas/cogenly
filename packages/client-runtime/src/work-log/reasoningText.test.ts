import { describe, expect, it } from "@effect/vitest";

import {
  markdownPreviewText,
  quietReasoningMarkdown,
  reasoningPlainText,
} from "./reasoningText.ts";

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

describe("markdownPreviewText", () => {
  it("reads a markdown and HTML result as one plain line", () => {
    expect(
      markdownPreviewText(
        '# 🔔 — iOS (Apple Color Emoji)\n\n### 1. Render\n<span style="color:red">Bell</span> **renders** as _expected_.',
      ),
    ).toBe("🔔 — iOS (Apple Color Emoji) Render Bell renders as expected.");
  });

  it("keeps link text, list items and code, dropping their markup", () => {
    expect(
      markdownPreviewText(
        "Hi — done, via two subagents:\n\n1. **Tee** at [Shop](https://example.com)\n- `pnpm test` passed\n> quoted",
      ),
    ).toBe("Hi — done, via two subagents: Tee at Shop pnpm test passed quoted");
  });

  it("keeps snake_case and literal asterisks inside words", () => {
    expect(markdownPreviewText("call delegate_task with a*b")).toBe("call delegate_task with a*b");
  });

  it("flattens tables and drops fences and entities", () => {
    expect(
      markdownPreviewText(
        "| a | b |\n| --- | --- |\n| 1 | 2 |\n```ts\nconst x = 1;\n```\nA &amp; B",
      ),
    ).toBe("a b 1 2 const x = 1; A & B");
  });
});

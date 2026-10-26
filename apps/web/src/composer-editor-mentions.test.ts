import { describe, expect, it } from "vite-plus/test";

import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";
import { collapseExpandedComposerCursor, expandCollapsedComposerCursor } from "./composer-logic";
import { buildDocJson } from "./composer-rich-text-doc";

const link = "[Run the Requested Audit](cogenly-thread://v1/5c3db2c5-fb2a)";
const prompt = `Compare with ${link} please`;
const noSkill = () => ({ label: "", description: null });

describe("thread links in the composer", () => {
  it("reads a pasted thread link as one chip that keeps the link as written", () => {
    expect(splitPromptIntoComposerSegments(prompt)).toEqual([
      { type: "text", text: "Compare with " },
      {
        type: "thread-link",
        threadId: "5c3db2c5-fb2a",
        label: "Run the Requested Audit",
        source: link,
      },
      { type: "text", text: " please" },
    ]);
    const paragraph = buildDocJson(prompt, noSkill).content[0] as {
      content: Array<{ type: string; attrs?: Record<string, unknown> }>;
    };
    expect(paragraph.content[1]).toEqual({
      type: "composer-thread-link",
      attrs: { threadId: "5c3db2c5-fb2a", label: "Run the Requested Audit", source: link },
    });
  });

  it("steps the caret over the chip in one move", () => {
    const before = "Compare with ".length;
    expect(expandCollapsedComposerCursor(prompt, before + 1)).toBe(before + link.length);
    expect(collapseExpandedComposerCursor(prompt, before + link.length)).toBe(before + 1);
  });

  it("leaves other links as text", () => {
    expect(splitPromptIntoComposerSegments("[docs](https://example.com)")).toEqual([
      { type: "text", text: "[docs](https://example.com)" },
    ]);
  });
});

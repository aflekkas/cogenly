import { assert, describe, it } from "@effect/vitest";

import { subagentThreadTitle } from "./subagentProjection.ts";

describe("subagentThreadTitle", () => {
  const title = (prompt: string, given?: string) =>
    subagentThreadTitle({ parentTitle: "Parent", prompt, title: given ?? null, ordinal: 2 });

  it("prefers the given title", () => {
    assert.strictEqual(title("Do the thing", "Attach files"), "Attach files");
  });

  it("names a prompt by its first line, whole, without a clipped ellipsis", () => {
    const line = "Act as the implementation sub-agent for this task and change the thread header";
    assert.strictEqual(title(`\n# ${line}\n\nYou are changing the web UI.`), line);
  });

  it("caps a very long line and falls back to the parent for an empty prompt", () => {
    assert.strictEqual(title("word ".repeat(100)).length <= 200, true);
    assert.strictEqual(title("  \n "), "Parent subagent 2");
  });
});

import { describe, expect, it } from "vite-plus/test";

import { composerPathSearchEntries } from "./composerPathSearchState";

const previous = [{ path: "src/sidebar.ts", kind: "file" as const }];
const next = [{ path: "src/single.ts", kind: "file" as const }];
const held = { scope: "env\u0000/repo", entries: previous };

describe("composerPathSearchEntries", () => {
  it("shows the last results while the next query has none yet", () => {
    expect(
      composerPathSearchEntries({ held, scope: held.scope, entries: [], isPending: true }),
    ).toBe(previous);
  });

  it("swaps in the new results once they arrive", () => {
    expect(
      composerPathSearchEntries({ held, scope: held.scope, entries: next, isPending: false }),
    ).toBe(next);
  });

  it("shows a settled empty result, so no match reads as no match", () => {
    expect(
      composerPathSearchEntries({ held, scope: held.scope, entries: [], isPending: false }),
    ).toEqual([]);
  });

  it("does not carry results into another folder or a cleared query", () => {
    expect(
      composerPathSearchEntries({ held, scope: "env\u0000/other", entries: [], isPending: true }),
    ).toEqual([]);
    expect(composerPathSearchEntries({ held, scope: null, entries: [], isPending: true })).toEqual(
      [],
    );
  });
});

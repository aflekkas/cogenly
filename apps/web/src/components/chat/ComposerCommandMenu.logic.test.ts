import { describe, expect, it } from "vite-plus/test";

import { composerMenuEmptyText, composerMenuSections } from "./ComposerCommandMenu.logic";

type Item = { readonly id: string; readonly group: "chats" | "files" | null };
const groupOf = (item: Item) => item.group;

describe("composerMenuSections", () => {
  it("keeps keyboard order by splitting into runs, never regrouping", () => {
    const items: Item[] = [
      { id: "a", group: "chats" },
      { id: "b", group: "chats" },
      { id: "c", group: "files" },
      { id: "d", group: "chats" },
    ];
    const { sections } = composerMenuSections(items, groupOf);
    const runs = sections.map((section) => [section.group, section.items.map((item) => item.id)]);
    expect(runs).toEqual([
      ["chats", ["a", "b"]],
      ["files", ["c"]],
      ["chats", ["d"]],
    ]);
    expect(sections.flatMap((section) => section.items)).toEqual(items);
  });

  it("shows headings only when there is more than files to tell apart", () => {
    expect(composerMenuSections([{ id: "a", group: "files" }], groupOf).showHeadings).toBe(false);
    expect(composerMenuSections([{ id: "a", group: "chats" }], groupOf).showHeadings).toBe(true);
    expect(
      composerMenuSections(
        [
          { id: "a", group: "files" },
          { id: "b", group: "chats" },
        ],
        groupOf,
      ).showHeadings,
    ).toBe(true);
  });
});

describe("composerMenuEmptyText", () => {
  it("says what it is searching while loading, even with a caller's empty text", () => {
    expect(
      composerMenuEmptyText({ triggerKind: "skill", isLoading: true, emptyStateText: "Nothing" }),
    ).toBe("Searching workspace skills...");
    expect(composerMenuEmptyText({ triggerKind: "path", isLoading: true })).toBe(
      "Searching workspace files...",
    );
  });

  it("prefers the caller's empty text once loaded, else the trigger's own", () => {
    expect(
      composerMenuEmptyText({ triggerKind: "path", isLoading: false, emptyStateText: "Nothing" }),
    ).toBe("Nothing");
    expect(composerMenuEmptyText({ triggerKind: "slash-command", isLoading: false })).toBe(
      "No matching command.",
    );
  });
});

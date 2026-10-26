import { describe, expect, it } from "vite-plus/test";

import {
  arrivedKeys,
  instructionsSaveState,
  mixProjectRecent,
  projectCardCount,
  projectFileTree,
  projectRecentPip,
  uploadFolderFor,
} from "./projectHome.logic";

interface Thread {
  readonly id: string;
  readonly at: string;
}

const mix = (input: {
  chats: ReadonlyArray<Thread>;
  work: ReadonlyArray<Thread>;
  limit?: number;
  exclude?: ReadonlySet<string>;
}) =>
  mixProjectRecent({
    ...input,
    keyOf: (thread) => thread.id,
    activityAt: (thread) => thread.at,
  });

describe("mixProjectRecent", () => {
  it("interleaves chats and Work newest first, tagging each", () => {
    const { items, hidden } = mix({
      chats: [
        { id: "c1", at: "2026-10-20T10:00:00Z" },
        { id: "c2", at: "2026-10-22T10:00:00Z" },
      ],
      work: [{ id: "w1", at: "2026-10-21T10:00:00Z" }],
    });
    expect(items.map((item) => [item.kind, item.key])).toEqual([
      ["chat", "c2"],
      ["work", "w1"],
      ["chat", "c1"],
    ]);
    expect(hidden).toBe(0);
  });

  it("caps the list and counts what it left out", () => {
    const chats = Array.from({ length: 4 }, (_, index) => ({
      id: `c${index}`,
      at: `2026-10-1${index}T00:00:00Z`,
    }));
    const work = Array.from({ length: 3 }, (_, index) => ({
      id: `w${index}`,
      at: `2026-09-1${index}T00:00:00Z`,
    }));
    const { items, hidden } = mix({ chats, work, limit: 5 });
    expect(items).toHaveLength(5);
    expect(hidden).toBe(2);
    expect(items[0]?.key).toBe("c3");
  });

  it("drops excluded threads before counting", () => {
    const { items, hidden } = mix({
      chats: [
        { id: "project-chat", at: "2026-10-22T00:00:00Z" },
        { id: "c1", at: "2026-10-21T00:00:00Z" },
      ],
      work: [],
      limit: 1,
      exclude: new Set(["project-chat"]),
    });
    expect(items.map((item) => item.key)).toEqual(["c1"]);
    expect(hidden).toBe(0);
  });

  it("keeps a stable order on ties: chats before Work, then input order", () => {
    const at = "2026-10-22T00:00:00Z";
    const { items } = mix({
      chats: [
        { id: "c1", at },
        { id: "c2", at },
      ],
      work: [{ id: "w1", at }],
    });
    expect(items.map((item) => item.key)).toEqual(["c1", "c2", "w1"]);
  });

  it("sorts unparseable times last", () => {
    const { items } = mix({
      chats: [{ id: "bad", at: "not a date" }],
      work: [{ id: "w1", at: "2026-10-22T00:00:00Z" }],
    });
    expect(items.map((item) => item.key)).toEqual(["w1", "bad"]);
  });
});

describe("projectRecentPip", () => {
  it("matches the sidebar: blocked needs you, running runs, failures fail", () => {
    for (const kind of ["chat", "work"] as const) {
      expect(projectRecentPip({ kind, status: "approval", latestRunCompleted: false })).toBe(
        "needs-you",
      );
      expect(projectRecentPip({ kind, status: "input", latestRunCompleted: false })).toBe(
        "needs-you",
      );
      expect(projectRecentPip({ kind, status: "working", latestRunCompleted: false })).toBe(
        "running",
      );
      expect(projectRecentPip({ kind, status: "waiting", latestRunCompleted: false })).toBe(
        "running",
      );
      expect(projectRecentPip({ kind, status: "limited", latestRunCompleted: false })).toBe(
        "failed",
      );
    }
  });

  it("marks finished Work done but leaves an idle chat bare", () => {
    expect(projectRecentPip({ kind: "work", status: "ready", latestRunCompleted: true })).toBe(
      "done",
    );
    expect(projectRecentPip({ kind: "work", status: "ready", latestRunCompleted: false })).toBe(
      null,
    );
    expect(projectRecentPip({ kind: "chat", status: "ready", latestRunCompleted: true })).toBe(
      null,
    );
  });
});

describe("projectCardCount", () => {
  it("hides a zero so an empty card reads through its copy", () => {
    expect(projectCardCount(0)).toBeNull();
    expect(projectCardCount(3)).toBe(3);
  });
});

describe("arrivedKeys", () => {
  it("treats the first snapshot as history, so nothing glows on load", () => {
    expect(arrivedKeys(null, ["a", "b"])).toEqual([]);
  });

  it("returns only keys a live change added", () => {
    expect(arrivedKeys(new Set(["a"]), ["a", "b", "c"])).toEqual(["b", "c"]);
  });

  it("ignores removals and reorders", () => {
    expect(arrivedKeys(new Set(["a", "b", "c"]), ["c", "a"])).toEqual([]);
  });
});

describe("instructionsSaveState", () => {
  it("is saved when the draft matches the server, ignoring trailing whitespace", () => {
    expect(
      instructionsSaveState({
        draft: "Use pnpm.\n\n",
        saved: "Use pnpm.",
        saving: false,
        failed: false,
      }),
    ).toBe("saved");
  });

  it("is unsaved for a changed draft, and failed once a save did not land", () => {
    expect(
      instructionsSaveState({
        draft: "Use bun.",
        saved: "Use pnpm.",
        saving: false,
        failed: false,
      }),
    ).toBe("unsaved");
    expect(
      instructionsSaveState({ draft: "Use bun.", saved: "Use pnpm.", saving: false, failed: true }),
    ).toBe("failed");
  });

  it("reports saving while a save is in flight", () => {
    expect(
      instructionsSaveState({ draft: "Use bun.", saved: "Use pnpm.", saving: true, failed: false }),
    ).toBe("saving");
  });
});

describe("projectFileTree", () => {
  const resource = (
    relativePath: string,
    kind: "file" | "folder",
    modifiedAt = "2026-01-01T00:00:00.000Z",
  ) => ({
    relativePath,
    kind,
    modifiedAt,
  });

  it("nests by path with folders first and files newest first", () => {
    const tree = projectFileTree([
      resource("Resources", "folder"),
      resource("Resources/old.md", "file", "2026-01-01T00:00:00.000Z"),
      resource("Resources/new.md", "file", "2026-02-01T00:00:00.000Z"),
      resource("Resources/Briefs", "folder"),
      resource("Resources/Briefs/a.pdf", "file"),
      resource("notes.txt", "file"),
    ]);
    expect(tree.map((node) => node.name)).toEqual(["Resources", "notes.txt"]);
    const resources = tree[0]!;
    expect(resources.children.map((node) => node.name)).toEqual(["Briefs", "new.md", "old.md"]);
    expect(resources.fileCount).toBe(3);
    expect(resources.children[0]!.children[0]!.path).toBe("Resources/Briefs/a.pdf");
  });

  it("keeps a folder only implied by a file under it", () => {
    const tree = projectFileTree([resource("Deep/inner/file.txt", "file")]);
    expect(tree[0]).toMatchObject({
      name: "Deep",
      kind: "folder",
      resource: undefined,
      fileCount: 1,
    });
  });
});

describe("uploadFolderFor", () => {
  it("places a file from an uploaded folder under the same subfolders", () => {
    expect(uploadFolderFor("Resources", "Trip/photos/a.jpg")).toBe("Resources/Trip/photos");
    expect(uploadFolderFor("Resources/Briefs", "a.pdf")).toBe("Resources/Briefs");
    expect(uploadFolderFor("Resources", "../x/a.pdf")).toBe("Resources/x");
  });
});

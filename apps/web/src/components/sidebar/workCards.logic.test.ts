import { generateSpreadPinOrderKeys } from "@t3tools/client-runtime/state/thread-sort";
import { describe, expect, it } from "vite-plus/test";

import {
  applyDrawnOrder,
  moveInOrder,
  planWorkCardReorder,
  rowShowsInSection,
  toggleCollapsedSection,
  workCardLabel,
} from "./workCards.logic";

describe("workCardLabel", () => {
  it("leads with the project, then the repository", () => {
    expect(workCardLabel({ projectName: "Spawn Partners", repositoryName: "platform" })).toBe(
      "Spawn Partners · platform",
    );
  });

  it("names the repository alone when it is in no project", () => {
    expect(workCardLabel({ projectName: null, repositoryName: "cogenly" })).toBe("cogenly");
  });

  it("names the project for repository-less Work in a project", () => {
    expect(workCardLabel({ projectName: "Spawn Partners", repositoryName: null })).toBe(
      "Spawn Partners",
    );
  });

  it("says No project for Work in neither", () => {
    expect(workCardLabel({ projectName: null, repositoryName: null })).toBe("No project");
  });
});

describe("moveInOrder", () => {
  it("moves one place up or down", () => {
    expect(moveInOrder(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveInOrder(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("stops at either end and ignores unknown keys", () => {
    expect(moveInOrder(["a", "b"], "a", -1)).toBeNull();
    expect(moveInOrder(["a", "b"], "b", 1)).toBeNull();
    expect(moveInOrder(["a", "b"], "z", 1)).toBeNull();
  });
});

describe("applyDrawnOrder", () => {
  it("follows the preview, drops removed cards and keeps new ones where the list put them", () => {
    expect(applyDrawnOrder(["a", "b", "new", "c"], ["c", "gone", "a", "b"])).toEqual([
      "c",
      "a",
      "b",
      "new",
    ]);
  });
});

describe("planWorkCardReorder", () => {
  it("writes one key between the moved card's new neighbours", () => {
    // Drawn top to bottom: y over x. Keys run up from the dock: x < y.
    const [low, mid, high] = generateSpreadPinOrderKeys(3) as [string, string, string];
    const keysById = new Map([
      ["x", low],
      ["y", mid],
      ["z", high],
    ]);
    // z moves from the top to between y and x.
    const writes = planWorkCardReorder({ drawnOrder: ["y", "z", "x"], keysById, movedId: "z" });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.id).toBe("z");
    expect(writes[0]!.orderKey > low && writes[0]!.orderKey < mid).toBe(true);
  });

  it("keys new, keyless cards once, avoiding keys held by cards not drawn", () => {
    const held = generateSpreadPinOrderKeys(1)[0]!;
    const keysById = new Map<string, string | null>([
      ["new", null],
      ["old", null],
      ["elsewhere", held],
    ]);
    const writes = planWorkCardReorder({ drawnOrder: ["new", "old"], keysById, movedId: "new" });
    const keyOf = new Map(writes.map((write) => [write.id, write.orderKey]));
    // Drawn above, so later in the order: a larger key.
    expect(keyOf.get("new")! > keyOf.get("old")!).toBe(true);
    expect([...keyOf.values()]).not.toContain(held);
  });
});

describe("toggleCollapsedSection", () => {
  it("collapses and expands per space", () => {
    const once = toggleCollapsedSection({}, "chats", "today");
    expect(once).toEqual({ chats: ["today"] });
    const other = toggleCollapsedSection(once, "tasks", "snoozed");
    expect(other).toEqual({ chats: ["today"], tasks: ["snoozed"] });
    expect(toggleCollapsedSection(other, "chats", "today")).toEqual({ tasks: ["snoozed"] });
  });

  it("round-trips through storage as plain JSON", () => {
    const stored = JSON.parse(
      JSON.stringify(toggleCollapsedSection({ chats: ["older"] }, "chats", "today")),
    );
    expect(stored).toEqual({ chats: ["older", "today"] });
  });
});

describe("rowShowsInSection", () => {
  it("keeps only the open thread under a folded heading", () => {
    expect(rowShowsInSection({ collapsed: false, isOpen: false })).toBe(true);
    expect(rowShowsInSection({ collapsed: true, isOpen: true })).toBe(true);
    expect(rowShowsInSection({ collapsed: true, isOpen: false })).toBe(false);
  });
});

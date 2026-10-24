import { generateSpreadPinOrderKeys } from "@t3tools/client-runtime/state/thread-sort";
import { describe, expect, it } from "vite-plus/test";

import {
  applyDrawnOrder,
  groupWorkCards,
  moveInOrder,
  NO_PROJECT_WORK_GROUP,
  placeInGroupOrder,
  planWorkCardReorder,
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

  it("names the repository alone under its project's heading", () => {
    expect(
      workCardLabel({
        projectName: "Spawn Partners",
        repositoryName: "platform",
        projectInHeading: true,
      }),
    ).toBe("platform");
    // The heading names the project; the card says where it runs.
    expect(
      workCardLabel({
        projectName: "Spawn Partners",
        repositoryName: null,
        projectInHeading: true,
      }),
    ).toBe("Project folder");
    expect(workCardLabel({ projectName: null, repositoryName: null, projectInHeading: true })).toBe(
      "No repository",
    );
  });
});

describe("groupWorkCards", () => {
  const projects: Record<string, { key: string; name: string } | null> = {
    a: { key: "env:zeta", name: "Zeta" },
    b: null,
    c: { key: "env:alpha", name: "alpha" },
    d: { key: "env:zeta", name: "Zeta" },
    e: null,
  };
  const grouped = groupWorkCards(["a", "b", "c", "d", "e"], (card) => projects[card] ?? null);

  it("orders projects by name, ignoring case, with No project last", () => {
    expect(grouped.map((group) => group.project?.name ?? null)).toEqual(["alpha", "Zeta", null]);
    expect(grouped.at(-1)!.key).toBe(NO_PROJECT_WORK_GROUP);
  });

  it("keeps each group's cards in the order they were drawn", () => {
    expect(grouped.map((group) => group.cards)).toEqual([["c"], ["a", "d"], ["b", "e"]]);
  });

  it("keeps same-named projects apart by key", () => {
    const twins = groupWorkCards(["x", "y"], (card) => ({ key: `env-${card}:p`, name: "Same" }));
    expect(twins.map((group) => group.key)).toEqual(["env-x:p", "env-y:p"]);
  });
});

describe("placeInGroupOrder", () => {
  // Groups interleave in the drawn order: a1, b1, a2, b2, a3.
  const order = ["a1", "b1", "a2", "b2", "a3"];

  it("puts the card before its new next neighbour in the group", () => {
    expect(placeInGroupOrder(order, ["a3", "a1", "a2"], "a3")).toEqual([
      "a3",
      "a1",
      "b1",
      "a2",
      "b2",
    ]);
  });

  it("puts a card moved to the group's end after its new previous neighbour", () => {
    expect(placeInGroupOrder(order, ["a2", "a3", "a1"], "a1")).toEqual([
      "b1",
      "a2",
      "b2",
      "a3",
      "a1",
    ]);
  });

  it("leaves the order alone for a card it does not know", () => {
    expect(placeInGroupOrder(order, ["a1", "a2"], "z")).toEqual(order);
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
  // The server's order is ascending keys: x, y, z.
  const [low, mid, high] = generateSpreadPinOrderKeys(3) as [string, string, string];
  const keysById = new Map([
    ["x", low],
    ["y", mid],
    ["z", high],
  ]);
  /** The server's order after applying `writes`: ascending by key. */
  const serverOrder = (writes: ReadonlyArray<{ id: string; orderKey: string }>) => {
    const keys = new Map(keysById);
    for (const write of writes) keys.set(write.id, write.orderKey);
    return [...keys].toSorted(([, a], [, b]) => (a < b ? -1 : 1)).map(([id]) => id);
  };

  it("keys the drawn order as is in the top layout", () => {
    // Drawn x, y, z; z moves up between x and y.
    const writes = planWorkCardReorder({
      layout: "top",
      drawnOrder: ["x", "z", "y"],
      keysById,
      movedId: "z",
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.orderKey > low && writes[0]!.orderKey < mid).toBe(true);
    expect(serverOrder(writes)).toEqual(["x", "z", "y"]);
  });

  it("keys the reverse of the drawn order in the bottom layout", () => {
    // Drawn z, y, x (newest-first end at the bottom); z moves down between y and x.
    const writes = planWorkCardReorder({
      layout: "bottom",
      drawnOrder: ["y", "z", "x"],
      keysById,
      movedId: "z",
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.orderKey > low && writes[0]!.orderKey < mid).toBe(true);
    expect(serverOrder(writes).toReversed()).toEqual(["y", "z", "x"]);
  });

  it("saves the same order for the same move in either layout", () => {
    // The same arrangement (server order x, z, y), drawn each layout's way.
    const top = planWorkCardReorder({
      layout: "top",
      drawnOrder: ["x", "z", "y"],
      keysById,
      movedId: "z",
    });
    const bottom = planWorkCardReorder({
      layout: "bottom",
      drawnOrder: ["y", "z", "x"],
      keysById,
      movedId: "z",
    });
    expect(bottom).toEqual(top);
  });

  it("keys new, keyless cards once, avoiding keys held by cards not drawn", () => {
    const held = generateSpreadPinOrderKeys(1)[0]!;
    const keyless = new Map<string, string | null>([
      ["new", null],
      ["old", null],
      ["elsewhere", held],
    ]);
    const bottom = planWorkCardReorder({
      layout: "bottom",
      drawnOrder: ["old", "new"],
      keysById: keyless,
      movedId: "new",
    });
    const keyOf = new Map(bottom.map((write) => [write.id, write.orderKey]));
    // Drawn below, by the dock, so earlier in the server's order: a smaller key.
    expect(keyOf.get("new")! < keyOf.get("old")!).toBe(true);
    expect([...keyOf.values()]).not.toContain(held);
    const top = planWorkCardReorder({
      layout: "top",
      drawnOrder: ["new", "old"],
      keysById: keyless,
      movedId: "new",
    });
    expect(top).toEqual(bottom);
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

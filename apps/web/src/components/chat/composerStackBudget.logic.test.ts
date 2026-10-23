import { describe, expect, it } from "vite-plus/test";

import {
  budgetComposerStack,
  composerStackCap,
  foldNotices,
  type ComposerStackPanel,
} from "./composerStackBudget.logic";

const header = 32;

function list(id: string, bodyHeight: number, rank: number): ComposerStackPanel {
  return { id, kind: "list", rank, chromeHeight: header, bodyHeight };
}

describe("budgetComposerStack", () => {
  it("leaves a stack that fits alone", () => {
    const budget = budgetComposerStack([list("queue", 100, 1), list("tasks", 100, 2)], 300);
    expect(budget.folded.size).toBe(0);
    expect(budget.bodyMax.size).toBe(0);
  });

  it("scrolls open lists inside the cap, giving a short list's spare room to a tall one", () => {
    // 64 of chrome leaves 236 for lists: the 80px queue fits whole, tasks take the rest.
    const budget = budgetComposerStack([list("queue", 80, 1), list("tasks", 400, 2)], 300);
    expect(budget.folded.size).toBe(0);
    expect(budget.bodyMax.get("queue")).toBe(80);
    expect(budget.bodyMax.get("tasks")).toBe(156);
    const total = 2 * header + budget.bodyMax.get("queue")! + budget.bodyMax.get("tasks")!;
    expect(total).toBeLessThanOrEqual(300);
  });

  it("folds the least important list when scrolling would leave a list unreadably short", () => {
    const budget = budgetComposerStack(
      [list("queue", 300, 1), list("tasks", 300, 3), list("background", 300, 2)],
      220,
    );
    // 124 of room split three or two ways is too short, so the queue and then
    // background work fold, least important first.
    expect([...budget.folded]).toEqual(["queue", "background"]);
    expect(budget.bodyMax.get("tasks")).toBe(124);
  });

  it("never folds a blocking question and counts it against the cap", () => {
    const question: ComposerStackPanel = {
      id: "question",
      kind: "blocking",
      rank: 0,
      chromeHeight: 260,
      bodyHeight: 0,
    };
    const budget = budgetComposerStack([question, list("tasks", 200, 2)], 300);
    expect(budget.folded.has("question")).toBe(false);
    expect(budget.folded.has("tasks")).toBe(true);
  });

  it("keeps a list the user reopened open, folding the others first", () => {
    const budget = budgetComposerStack(
      [{ ...list("queue", 300, 1), pinned: true }, list("tasks", 300, 3)],
      150,
    );
    expect([...budget.folded]).toEqual(["tasks"]);
    expect(budget.bodyMax.get("queue")).toBe(86);
  });

  it("does not budget a list the user closed", () => {
    const budget = budgetComposerStack([list("queue", 0, 1), list("tasks", 200, 2)], 300);
    expect(budget.folded.size).toBe(0);
    expect(budget.bodyMax.size).toBe(0);
  });

  it("caps the stack at a third of the pane", () => {
    expect(composerStackCap(900)).toBe(300);
    expect(composerStackCap(0)).toBe(0);
  });
});

describe("foldNotices", () => {
  const notice = (id: string, foldable = true) => ({ id, foldable });

  it("keeps two notices as they are", () => {
    expect(foldNotices([notice("a"), notice("b")], false)).toEqual({
      hidden: new Set(),
      overflow: 0,
    });
  });

  it("keeps the most important of three or more and folds the rest", () => {
    const folded = foldNotices([notice("update"), notice("tip"), notice("limit")], false);
    expect([...folded.hidden]).toEqual(["tip", "limit"]);
    expect(folded.overflow).toBe(2);
  });

  it("shows every notice once expanded but keeps the bar to fold them again", () => {
    const expanded = foldNotices([notice("a"), notice("b"), notice("c")], true);
    expect(expanded.hidden.size).toBe(0);
    expect(expanded.overflow).toBe(2);
  });

  it("never folds a notice that must stay in view", () => {
    const folded = foldNotices(
      [notice("error", false), notice("a"), notice("b"), notice("c")],
      false,
    );
    expect(folded.hidden.has("error")).toBe(false);
    expect([...folded.hidden]).toEqual(["b", "c"]);
  });
});

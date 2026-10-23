import { describe, expect, it } from "vite-plus/test";

import {
  pendingSubagentCompletions,
  type PendingCompletionSubagentInput,
} from "./pendingSubagentCompletions.logic";

const native = (
  overrides: Partial<PendingCompletionSubagentInput> = {},
): PendingCompletionSubagentInput => ({
  id: "task",
  threadId: "parent",
  origin: "provider_native",
  childThreadId: "child",
  status: "completed",
  completedAtMs: 1_000,
  ...overrides,
});

const pending = (
  subagents: ReadonlyArray<PendingCompletionSubagentInput>,
  options: {
    readonly notified?: ReadonlyArray<readonly [string, number]>;
    readonly background?: ReadonlyArray<string>;
  } = {},
) =>
  pendingSubagentCompletions({
    threadId: "parent",
    subagents,
    notifiedAtMsByChild: new Map(options.notified ?? []),
    backgroundChildren: new Set(options.background ?? ["child"]),
  });

describe("pendingSubagentCompletions", () => {
  it("shows a background subagent the moment it finishes, before the parent is told", () => {
    expect(pending([native()])).toEqual([
      { subagentId: "task", childThreadId: "child", outcome: "completed", completedAtMs: 1_000 },
    ]);
  });

  it("gives way once the parent's notification for that completion lands", () => {
    expect(pending([native()], { notified: [["child", 1_200]] })).toEqual([]);
    // An older notification (an earlier run of the same child) does not count.
    expect(pending([native()], { notified: [["child", 500]] })).toHaveLength(1);
  });

  it("leaves running and foreground subagents alone", () => {
    expect(pending([native({ status: "running", completedAtMs: null })])).toEqual([]);
    expect(pending([native()], { background: [] })).toEqual([]);
  });

  it("follows an app-owned delegation's own delivery state", () => {
    const delegated = native({ origin: "app_owned", completionDelivery: { state: "pending" } });
    expect(pending([delegated], { background: [] })).toHaveLength(1);
    expect(
      pending([{ ...delegated, completionDelivery: { state: "delivered" } }], { background: [] }),
    ).toEqual([]);
  });

  it("maps every way a subagent can end, one row per child, oldest first", () => {
    const rows = pending(
      [
        native({ id: "a", childThreadId: "a", status: "failed", completedAtMs: 3_000 }),
        native({ id: "b", childThreadId: "b", status: "interrupted", completedAtMs: 2_000 }),
        native({ id: "b-old", childThreadId: "b", completedAtMs: 1_000 }),
      ],
      { background: ["a", "b"] },
    );
    expect(rows.map((row) => [row.subagentId, row.outcome])).toEqual([
      ["b", "cancelled"],
      ["a", "failed"],
    ]);
  });

  it("ignores another thread's subagents", () => {
    expect(pending([native({ threadId: "elsewhere" })])).toEqual([]);
  });
});

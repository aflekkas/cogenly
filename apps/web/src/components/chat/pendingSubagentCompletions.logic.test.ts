import { describe, expect, it } from "vite-plus/test";
import { NodeId } from "@cogenly/contracts";

import {
  pendingSubagentCompletions,
  notifiedSubagentCompletionTimes,
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
  startedAtMs: 500,
  completedAtMs: 1_000,
  ...overrides,
});

const pending = (
  subagents: ReadonlyArray<PendingCompletionSubagentInput>,
  options: {
    readonly notified?: ReadonlyArray<readonly [string, number]>;
    readonly background?: ReadonlyArray<string>;
    readonly notifiedTasks?: ReadonlyArray<readonly [string, number]>;
    readonly parentRunAt?: number;
  } = {},
) =>
  pendingSubagentCompletions({
    threadId: "parent",
    subagents,
    notifiedAtMsByChild: new Map(options.notified ?? []),
    notifiedAtMsByTask: new Map(options.notifiedTasks ?? []),
    backgroundChildren: new Set(options.background ?? ["child"]),
    latestParentRunAtMs: options.parentRunAt ?? null,
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

  it("settles the footer when a batched rate-limit notice identifies its tasks", () => {
    const task = native({
      origin: "app_owned",
      status: "failed",
      completionDelivery: { state: "claimed" },
    });
    const notified = notifiedSubagentCompletionTimes([
      { source: { kind: "delegated_task", taskIds: [NodeId.make(task.id)] }, atMs: 1_000 },
    ]);
    expect(
      pendingSubagentCompletions({
        threadId: "parent",
        subagents: [task],
        backgroundChildren: new Set(),
        notifiedAtMsByChild: notified.byChild,
        notifiedAtMsByTask: notified.byTask,
        latestParentRunAtMs: null,
      }),
    ).toEqual([]);
    // A prior notice cannot acknowledge a new completion of the same task.
    expect(pending([task], { notifiedTasks: [[task.id, 900]] })).toHaveLength(1);
  });

  it("returns a pending result to history when a later parent turn supersedes the footer", () => {
    const task = native({
      origin: "app_owned",
      status: "failed",
      completionDelivery: { state: "claimed" },
    });
    expect(pending([task], { parentRunAt: 2_000 })).toEqual([]);
    // Completing while the parent is still busy warrants the transient row.
    expect(pending([task], { parentRunAt: 500 })).toHaveLength(1);
  });

  it.each(["pending", "running", "completed", "failed", "cancelled"])(
    "does not pin an earlier failure after the child resumes and is %s",
    (status) => {
      const old = native({
        origin: "app_owned",
        status: "failed",
        completionDelivery: { state: "claimed" },
      });
      const resumed = native({
        id: "resumed",
        status,
        startedAtMs: 2_000,
        completedAtMs: status === "pending" || status === "running" ? null : 3_000,
      });
      expect(pending([resumed, old], { background: [] })).toEqual([]);
    },
  );
});

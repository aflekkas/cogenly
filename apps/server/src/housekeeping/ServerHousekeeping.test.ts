import { describe, expect, it } from "@effect/vitest";

import {
  planDatabaseMaintenance,
  planLogPruning,
  planWorktreeCleanup,
  type WorktreeCandidate,
} from "./ServerHousekeeping.ts";

const candidate = (overrides: Partial<WorktreeCandidate>): WorktreeCandidate => ({
  worktreePath: "/worktrees/repo/branch",
  threadState: "deleted",
  hasUncommittedChanges: false,
  hasUnpushedCommits: false,
  isLinkedWorktree: true,
  ...overrides,
});

describe("planWorktreeCleanup safety rule", () => {
  it("removes a clean, pushed worktree whose thread was deleted", () => {
    const plan = planWorktreeCleanup([candidate({})]);
    expect(plan.remove).toEqual(["/worktrees/repo/branch"]);
    expect(plan.keep).toEqual([]);
  });

  it("removes a clean, pushed worktree whose thread was archived or is gone", () => {
    const plan = planWorktreeCleanup([
      candidate({ worktreePath: "/wt/archived", threadState: "archived" }),
      candidate({ worktreePath: "/wt/missing", threadState: "missing" }),
    ]);
    expect(plan.remove).toEqual(["/wt/archived", "/wt/missing"]);
  });

  it("never removes a worktree with uncommitted changes", () => {
    const plan = planWorktreeCleanup([candidate({ hasUncommittedChanges: true })]);
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual([
      { worktreePath: "/worktrees/repo/branch", reason: "has uncommitted changes" },
    ]);
  });

  it("never removes a worktree with unpushed commits", () => {
    const plan = planWorktreeCleanup([candidate({ hasUnpushedCommits: true })]);
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual([
      { worktreePath: "/worktrees/repo/branch", reason: "has unpushed commits" },
    ]);
  });

  it("keeps active threads, non-linked folders, and uninspectable worktrees", () => {
    const plan = planWorktreeCleanup([
      candidate({ worktreePath: "/wt/active", threadState: "active" }),
      candidate({ worktreePath: "/wt/main", isLinkedWorktree: false }),
      candidate({ worktreePath: "/wt/unknown", hasUncommittedChanges: null }),
      candidate({ worktreePath: "/wt/unknown-push", hasUnpushedCommits: null }),
    ]);
    expect(plan.remove).toEqual([]);
    expect(plan.keep.map((entry) => entry.reason)).toEqual([
      "thread is still active",
      "not a linked worktree",
      "could not inspect git state",
      "could not inspect git state",
    ]);
  });
});

describe("planLogPruning", () => {
  const now = 1_800_000_000_000;
  const day = 86_400_000;

  it("removes only files older than the retention window", () => {
    const plan = planLogPruning(
      [
        { path: "/logs/old.log.1", modifiedAtMs: now - 31 * day },
        { path: "/logs/fresh.log", modifiedAtMs: now - 1 * day },
      ],
      now,
      30,
    );
    expect(plan.remove).toEqual(["/logs/old.log.1"]);
    expect(plan.keep).toEqual(["/logs/fresh.log"]);
  });

  it("removes nothing when retention is unset", () => {
    const plan = planLogPruning([{ path: "/logs/old.log.1", modifiedAtMs: 0 }], now, null);
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual(["/logs/old.log.1"]);
  });
});

describe("planDatabaseMaintenance", () => {
  it("always optimizes, vacuums only with incremental vacuum and free pages", () => {
    expect(planDatabaseMaintenance({ incrementalVacuumEnabled: true, freelistCount: 10 })).toEqual({
      runOptimize: true,
      runIncrementalVacuum: true,
    });
    expect(planDatabaseMaintenance({ incrementalVacuumEnabled: true, freelistCount: 0 })).toEqual({
      runOptimize: true,
      runIncrementalVacuum: false,
    });
    expect(planDatabaseMaintenance({ incrementalVacuumEnabled: false, freelistCount: 10 })).toEqual(
      { runOptimize: true, runIncrementalVacuum: false },
    );
  });
});

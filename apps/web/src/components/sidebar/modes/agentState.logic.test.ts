import { EnvironmentId, ProjectId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_DONE_WINDOW_MS,
  buildAgentGroups,
  countAgentsNeedingYou,
  deriveAgentPresentation,
  formatAgentFutureTime,
  type AgentTask,
  type AgentThread,
} from "./agentState.logic";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const minutes = (count: number) => count * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  id: ScheduledTaskId.make("task-1"),
  title: "Nightly triage",
  enabled: true,
  schedule: { type: "interval", everyMs: minutes(60) },
  projectId: ProjectId.make("project-1"),
  threadId: ThreadId.make("thread-1"),
  nextRunAt: iso(NOW + minutes(5)),
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  ...overrides,
});

const thread = (overrides: Partial<AgentThread> = {}): AgentThread => ({
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingSubagentRequest: null,
  runtime: null,
  latestRun: null,
  ...overrides,
});

const runtime = (
  status: NonNullable<AgentThread["runtime"]>["status"],
  extra: Partial<NonNullable<AgentThread["runtime"]>> = {},
): NonNullable<AgentThread["runtime"]> => ({
  status,
  activeRunId: null,
  providerInstanceId: "codex" as never,
  providerName: null,
  lastError: null,
  updatedAt: iso(NOW),
  ...extra,
});

const completedRun = (completedAtMs: number): NonNullable<AgentThread["latestRun"]> => ({
  runId: "run-1" as never,
  status: "completed",
  requestedAt: iso(completedAtMs - minutes(2)),
  startedAt: iso(completedAtMs - minutes(2)),
  completedAt: iso(completedAtMs),
  assistantMessageId: null,
});

const derive = (taskOverrides: Partial<AgentTask>, threadValue: AgentThread | null) =>
  deriveAgentPresentation({ task: task(taskOverrides), thread: threadValue, nowMs: NOW });

describe("deriveAgentPresentation", () => {
  it("is asleep with the next run while scheduled and idle", () => {
    expect(derive({}, thread())).toEqual({
      state: "asleep",
      statusText: "Next run in 5m",
      tone: "muted",
    });
  });

  it("is idle and paused while the task is disabled", () => {
    expect(derive({ enabled: false }, thread())).toEqual({
      state: "idle",
      statusText: "Paused",
      tone: "muted",
    });
  });

  it("works while the thread runs", () => {
    expect(derive({}, thread({ runtime: runtime("running") })).state).toBe("working");
    expect(
      derive(
        {},
        thread({ runtime: runtime("running", { activityStartedAt: iso(NOW - minutes(3)) }) }),
      ).statusText,
    ).toBe("Working · 3m");
  });

  it("works while the scheduler reports a running run on an unbound task", () => {
    expect(derive({ threadId: null, lastRunStatus: "running" }, null).state).toBe("working");
  });

  it("needs you for a pending approval or question, even while paused", () => {
    expect(derive({ enabled: false }, thread({ hasPendingApprovals: true }))).toEqual({
      state: "needsYou",
      statusText: "Needs your approval",
      tone: "attention",
    });
    expect(derive({}, thread({ hasPendingUserInput: true })).statusText).toBe(
      "Waiting for your answer",
    );
    expect(derive({}, thread({ pendingSubagentRequest: "user_input" })).state).toBe("needsYou");
  });

  it("needing you outranks a running thread", () => {
    expect(
      derive({}, thread({ hasPendingUserInput: true, runtime: runtime("running") })).state,
    ).toBe("needsYou");
  });

  it("is blocked when the last run failed, showing the first line of the error", () => {
    expect(
      derive({ lastRunStatus: "failed", lastRunError: "Workspace missing\nstack…" }, thread()),
    ).toEqual({ state: "blocked", statusText: "Failed: Workspace missing", tone: "error" });
    expect(derive({}, thread({ runtime: runtime("failed") })).statusText).toBe("Last run failed");
    expect(
      derive({}, thread({ runtime: runtime("failed", { lastErrorClass: "usage_limit" }) }))
        .statusText,
    ).toBe("Hit a usage limit");
  });

  it("is done for a few minutes after a run completes, then goes back to sleep", () => {
    expect(derive({}, thread({ latestRun: completedRun(NOW - minutes(2)) }))).toEqual({
      state: "done",
      statusText: "Finished 2m ago",
      tone: "success",
    });
    expect(
      derive({}, thread({ latestRun: completedRun(NOW - AGENT_DONE_WINDOW_MS - 1) })).state,
    ).toBe("asleep");
  });

  it("prefers the thread's own latest run over the scheduler's record", () => {
    const failedRun = { ...completedRun(NOW - minutes(1)), status: "failed" as const };
    expect(
      derive(
        { lastRunStatus: "succeeded", lastRunAt: iso(NOW - minutes(1)) },
        thread({ latestRun: failedRun }),
      ).state,
    ).toBe("asleep");
    expect(
      derive({ lastRunStatus: "succeeded", lastRunAt: iso(NOW - minutes(1)) }, thread()).state,
    ).toBe("done");
  });

  it("uses the scheduler's last run for done when no thread is bound", () => {
    expect(
      derive({ threadId: null, lastRunStatus: "succeeded", lastRunAt: iso(NOW - minutes(1)) }, null)
        .state,
    ).toBe("done");
  });

  it("describes webhook and unscheduled tasks without a time", () => {
    expect(
      derive({ schedule: { type: "webhook", signature: null }, nextRunAt: null }, thread())
        .statusText,
    ).toBe("Waiting for a webhook");
    expect(derive({ nextRunAt: null }, thread()).statusText).toBe("Scheduled");
  });
});

describe("formatAgentFutureTime", () => {
  it("rounds to the coarsest useful unit", () => {
    expect(formatAgentFutureTime(NOW + 30_000, NOW)).toBe("in under a minute");
    expect(formatAgentFutureTime(NOW + minutes(42), NOW)).toBe("in 42m");
    expect(formatAgentFutureTime(NOW + minutes(150), NOW)).toBe("in 3h");
    expect(formatAgentFutureTime(NOW + minutes(60 * 50), NOW)).toBe("in 2d");
  });
});

describe("buildAgentGroups", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");
  const labels: Record<string, string> = {
    "env-a:web": "web",
    "env-a:api": "api",
    "env-b:web": "web",
  };
  const entry = (
    environmentId: EnvironmentId,
    projectId: string,
    overrides: Partial<AgentTask>,
  ) => ({
    environmentId,
    task: task({ projectId: ProjectId.make(projectId), ...overrides }),
    thread: null,
  });

  it("groups by project per environment and puts agents that need you first", () => {
    const groups = buildAgentGroups(
      [
        entry(envA, "web", { id: ScheduledTaskId.make("a"), title: "Alpha" }),
        entry(envA, "web", {
          id: ScheduledTaskId.make("b"),
          title: "Beta",
          lastRunStatus: "failed",
        }),
        entry(envA, "api", { id: ScheduledTaskId.make("c"), title: "Gamma", enabled: false }),
        entry(envB, "web", { id: ScheduledTaskId.make("a"), title: "Remote" }),
      ],
      {
        nowMs: NOW,
        projectLabel: (environmentId, projectId) => labels[`${environmentId}:${projectId}`]!,
      },
    );
    expect(groups.map((group) => group.projectKey)).toEqual([
      "env-a:api",
      "env-a:web",
      "env-b:web",
    ]);
    expect(groups[1]!.rows.map((row) => row.task.title)).toEqual(["Beta", "Alpha"]);
    // Same task id on two machines stays two agents.
    expect(new Set(groups.flatMap((group) => group.rows.map((row) => row.key))).size).toBe(4);
  });

  it("counts agents that need you", () => {
    const groups = buildAgentGroups(
      [
        {
          environmentId: envA,
          task: task({ id: ScheduledTaskId.make("x") }),
          thread: thread({ hasPendingApprovals: true }),
        },
        { environmentId: envA, task: task({ id: ScheduledTaskId.make("y") }), thread: thread() },
        {
          environmentId: envB,
          task: task({ id: ScheduledTaskId.make("z") }),
          thread: thread({ hasPendingUserInput: true }),
        },
      ],
      { nowMs: NOW, projectLabel: () => "project" },
    );
    expect(countAgentsNeedingYou(groups)).toBe(2);
  });
});

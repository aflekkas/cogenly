/**
 * Agents are scheduled tasks for now: one row per task, showing the thread it
 * is bound to when there is one. This module turns task and thread data into
 * what a row shows — the face state, a one-line status, and its tone — with
 * no clock or store of its own, so every rule is unit-tested.
 */
import type { EnvironmentId, ProjectId, ScheduledTask } from "@t3tools/contracts";

import type { AgentFaceState } from "../../agents/face";
import { resolveSidebarThreadStatus } from "../../Sidebar.logic";
import type { SidebarThreadSummary } from "../../../types";

/** How long a finished run keeps the agent looking pleased with itself. */
export const AGENT_DONE_WINDOW_MS = 5 * 60_000;

export type AgentTask = Pick<
  ScheduledTask,
  | "id"
  | "title"
  | "enabled"
  | "schedule"
  | "projectId"
  | "threadId"
  | "nextRunAt"
  | "lastRunAt"
  | "lastRunStatus"
  | "lastRunError"
>;

export type AgentThread = Pick<
  SidebarThreadSummary,
  "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest" | "runtime" | "latestRun"
>;

/** Text colour of the status line; maps onto the sidebar's status hues. */
export type AgentStatusTone = "attention" | "working" | "error" | "success" | "muted";

export interface AgentPresentation {
  readonly state: AgentFaceState;
  readonly statusText: string;
  readonly tone: AgentStatusTone;
}

function parseMs(value: string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** "in under a minute", "in 5m", "in 3h", "in 2d". */
export function formatAgentFutureTime(atMs: number, nowMs: number): string {
  const minutes = Math.ceil((atMs - nowMs) / 60_000);
  if (minutes < 2) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function formatAgentPastTime(atMs: number, nowMs: number): string {
  const minutes = Math.floor((nowMs - atMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]!.trim();
}

/** When the agent's latest run finished successfully, or null. */
function completedAtMs(task: AgentTask, thread: AgentThread | null): number | null {
  // The thread's own latest run is the freshest truth when it has one.
  if (thread?.latestRun) {
    return thread.latestRun.status === "completed" ? parseMs(thread.latestRun.completedAt) : null;
  }
  return task.lastRunStatus === "succeeded" ? parseMs(task.lastRunAt) : null;
}

/**
 * Precedence, most urgent first: needs you, working, blocked, just done, then
 * the resting states (asleep while scheduled, idle while paused).
 */
export function deriveAgentPresentation(input: {
  readonly task: AgentTask;
  readonly thread: AgentThread | null;
  readonly nowMs: number;
}): AgentPresentation {
  const { task, thread, nowMs } = input;
  const threadStatus = thread ? resolveSidebarThreadStatus(thread) : null;

  if (threadStatus === "approval") {
    return { state: "needsYou", statusText: "Needs your approval", tone: "attention" };
  }
  if (threadStatus === "input") {
    return { state: "needsYou", statusText: "Waiting for your answer", tone: "attention" };
  }
  if (
    threadStatus === "working" ||
    threadStatus === "waiting" ||
    task.lastRunStatus === "running"
  ) {
    const startedAt = parseMs(thread?.runtime?.activityStartedAt ?? null);
    const minutes = startedAt === null ? 0 : Math.floor((nowMs - startedAt) / 60_000);
    return {
      state: "working",
      statusText:
        minutes < 1
          ? "Working"
          : `Working · ${minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`}`,
      tone: "working",
    };
  }
  if (threadStatus === "limited") {
    return { state: "blocked", statusText: "Hit a usage limit", tone: "error" };
  }
  if (threadStatus === "failed" || task.lastRunStatus === "failed") {
    const error = task.lastRunError ?? thread?.runtime?.lastError ?? null;
    const detail = error ? firstLine(error) : "";
    return {
      state: "blocked",
      statusText: detail ? `Failed: ${detail}` : "Last run failed",
      tone: "error",
    };
  }
  const completedAt = completedAtMs(task, thread);
  if (
    completedAt !== null &&
    nowMs - completedAt >= 0 &&
    nowMs - completedAt < AGENT_DONE_WINDOW_MS
  ) {
    return {
      state: "done",
      statusText: `Finished ${formatAgentPastTime(completedAt, nowMs)}`,
      tone: "success",
    };
  }
  if (!task.enabled) {
    return { state: "idle", statusText: "Paused", tone: "muted" };
  }
  if (task.schedule.type === "webhook") {
    return { state: "asleep", statusText: "Waiting for a webhook", tone: "muted" };
  }
  const nextRunAt = parseMs(task.nextRunAt);
  return {
    state: "asleep",
    statusText:
      nextRunAt === null ? "Scheduled" : `Next run ${formatAgentFutureTime(nextRunAt, nowMs)}`,
    tone: "muted",
  };
}

// Rows and groups -------------------------------------------------------------

export interface AgentEntry<TThread extends AgentThread = AgentThread> {
  readonly environmentId: EnvironmentId;
  readonly task: AgentTask;
  /** The bound thread, when the task has one and this client has its shell. */
  readonly thread: TThread | null;
}

export interface AgentRow<TThread extends AgentThread = AgentThread> extends AgentEntry<TThread> {
  /** Unique across environments. */
  readonly key: string;
  readonly presentation: AgentPresentation;
}

export interface AgentGroup<TThread extends AgentThread = AgentThread> {
  /** `environmentId:projectId`. */
  readonly projectKey: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label: string;
  readonly rows: ReadonlyArray<AgentRow<TThread>>;
}

const STATE_RANK: Record<AgentFaceState, number> = {
  needsYou: 0,
  blocked: 1,
  working: 2,
  thinking: 2,
  done: 3,
  created: 3,
  asleep: 4,
  idle: 5,
};

/**
 * Groups by project (labels A–Z, ties by key so same-named projects on two
 * machines stay apart and stable). Inside a group, agents that want something
 * come first, then by name.
 */
export function buildAgentGroups<TThread extends AgentThread>(
  entries: ReadonlyArray<AgentEntry<TThread>>,
  options: {
    readonly nowMs: number;
    readonly projectLabel: (environmentId: EnvironmentId, projectId: ProjectId) => string;
  },
): AgentGroup<TThread>[] {
  const groups = new Map<
    string,
    { environmentId: EnvironmentId; projectId: ProjectId; label: string; rows: AgentRow<TThread>[] }
  >();
  for (const entry of entries) {
    const projectKey = `${entry.environmentId}:${entry.task.projectId}`;
    let group = groups.get(projectKey);
    if (!group) {
      group = {
        environmentId: entry.environmentId,
        projectId: entry.task.projectId,
        label: options.projectLabel(entry.environmentId, entry.task.projectId),
        rows: [],
      };
      groups.set(projectKey, group);
    }
    group.rows.push({
      ...entry,
      key: `${entry.environmentId}:${entry.task.id}`,
      presentation: deriveAgentPresentation({
        task: entry.task,
        thread: entry.thread,
        nowMs: options.nowMs,
      }),
    });
  }
  return [...groups.entries()]
    .map(([projectKey, group]) => ({
      projectKey,
      environmentId: group.environmentId,
      projectId: group.projectId,
      label: group.label,
      rows: group.rows.toSorted(
        (left, right) =>
          STATE_RANK[left.presentation.state] - STATE_RANK[right.presentation.state] ||
          left.task.title.localeCompare(right.task.title) ||
          left.key.localeCompare(right.key),
      ),
    }))
    .toSorted(
      (left, right) =>
        left.label.localeCompare(right.label) || left.projectKey.localeCompare(right.projectKey),
    );
}

export function countAgentsNeedingYou(groups: ReadonlyArray<AgentGroup>): number {
  let count = 0;
  for (const group of groups) {
    for (const row of group.rows) if (row.presentation.state === "needsYou") count += 1;
  }
  return count;
}

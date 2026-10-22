/**
 * The thread details "Agents" list: every agent a thread spawned or handed
 * work to, normalized into one roster. Sources:
 *  - the thread projection's subagents (provider-native tasks and app-owned
 *    delegations, including workflow coordinators and their members);
 *  - child thread shells whose lineage names this thread as their subagent
 *    parent (delegated tasks that have their own conversation);
 *  - Work threads started from this thread (chat handoffs and agent work).
 * Forks are lineage, not agents, so they are left out.
 */

import type { SubagentOutcome } from "./subagentRow.logic";
export type ThreadAgentStatus = "running" | "done" | "failed" | "cancelled";
export type ThreadAgentKind = "subagent" | "workflow" | "workflow_member" | "task";

export interface ThreadAgentSubagentInput {
  readonly id: string;
  readonly threadId: string;
  readonly origin: "provider_native" | "app_owned";
  readonly driver: string;
  readonly providerInstanceId: string;
  readonly childThreadId: string | null;
  readonly runId: string | null;
  /** True when the provider gave a strong native handle that a stop can target. */
  readonly hasStrongNativeTask: boolean;
  readonly title: string | null;
  readonly prompt: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
  readonly workflow?: {
    readonly name: string | null;
    readonly agents: ReadonlyArray<{
      readonly index: number;
      readonly label: string;
      readonly childThreadId?: string | undefined;
      readonly state: "queued" | "running" | "completed" | "failed";
      readonly startedAt?: number | undefined;
      readonly durationMs?: number | undefined;
      readonly queuedAt?: number | undefined;
    }>;
  };
}

export interface ThreadAgentThreadInput {
  readonly id: string;
  readonly title: string;
  readonly providerInstanceId: string;
  readonly parentThreadId: string | null;
  readonly relationshipToParent: "fork" | "subagent" | null;
  /** The chat or agent conversation a Work thread was started from. */
  readonly sourceThreadId: string | null;
  /** Live activity when present, else the settled shell status. */
  readonly status: string;
  /** Whether the thread has run at least once; a never-run child defers to its task. */
  readonly hasRun: boolean;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
}

export type ThreadAgentStopTarget =
  | { readonly type: "thread"; readonly threadId: string }
  | { readonly type: "subagent"; readonly threadId: string; readonly subagentId: string }
  | { readonly type: "workflow"; readonly threadId: string; readonly subagentId: string };

export interface ThreadAgentRow {
  readonly key: string;
  readonly kind: ThreadAgentKind;
  readonly title: string;
  readonly status: ThreadAgentStatus;
  /** Finer label inside a status bucket, e.g. Queued or Waiting while running. */
  readonly statusLabel: string;
  readonly driver: string | null;
  readonly providerInstanceId: string | null;
  /** The conversation a row opens; null when the agent has none of its own. */
  readonly threadId: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** When the row last began: its start, else when it was created or seen. */
  readonly sortAt: string;
  readonly stop: ThreadAgentStopTarget | null;
  readonly children: ReadonlyArray<ThreadAgentRow>;
}

export interface ThreadAgentsSummary {
  readonly rows: ReadonlyArray<ThreadAgentRow>;
  /** Every row, nested ones included. */
  readonly total: number;
  readonly failed: number;
  readonly running: number;
}

const RUNNING = new Set(["pending", "running", "waiting", "preparing", "queued", "starting"]);
const FAILED = new Set(["failed", "error"]);
const CANCELLED = new Set(["cancelled", "interrupted", "rolled_back"]);

export function resolveThreadAgentStatus(status: string): ThreadAgentStatus {
  if (RUNNING.has(status)) return "running";
  if (FAILED.has(status)) return "failed";
  if (CANCELLED.has(status)) return "cancelled";
  return "done";
}

export function threadAgentStatusLabel(status: string): string {
  switch (status) {
    case "pending":
    case "queued":
    case "preparing":
    case "starting":
      return "Queued";
    case "waiting":
      return "Waiting";
    case "running":
      return "Running";
    case "failed":
    case "error":
      return "Failed";
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return "Cancelled";
    case "idle":
      return "Idle";
    default:
      return "Done";
  }
}

function subagentTitle(subagent: ThreadAgentSubagentInput, childTitle: string | undefined) {
  const title = subagent.workflow?.name ?? subagent.title ?? childTitle ?? subagent.prompt.trim();
  const display = title.replace(/^Subagent:\s*/i, "").trim();
  if (display.length === 0) return "Subagent";
  return display.length > 80 ? `${display.slice(0, 77)}...` : display;
}

function isoFromMillis(value: number | undefined): string | null {
  return value === undefined || !Number.isFinite(value) ? null : new Date(value).toISOString();
}

function compareRows(left: ThreadAgentRow, right: ThreadAgentRow): number {
  const leftRunning = left.status === "running" ? 0 : 1;
  const rightRunning = right.status === "running" ? 0 : 1;
  if (leftRunning !== rightRunning) return leftRunning - rightRunning;
  const leftAt = Date.parse(left.sortAt);
  const rightAt = Date.parse(right.sortAt);
  const leftValid = Number.isFinite(leftAt);
  const rightValid = Number.isFinite(rightAt);
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  if (leftValid && rightAt !== leftAt) return rightAt - leftAt;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

export function sortThreadAgentRows(rows: ReadonlyArray<ThreadAgentRow>): ThreadAgentRow[] {
  return [...rows].sort(compareRows);
}

function threadRow(
  thread: ThreadAgentThreadInput,
  kind: ThreadAgentKind,
  children: ReadonlyArray<ThreadAgentRow>,
): ThreadAgentRow {
  const status = resolveThreadAgentStatus(thread.status);
  return {
    key: `thread:${thread.id}`,
    kind,
    title: thread.title.replace(/^Subagent:\s*/i, "").trim() || "Untitled",
    status,
    statusLabel: threadAgentStatusLabel(thread.status),
    driver: null,
    providerInstanceId: thread.providerInstanceId,
    threadId: thread.id,
    startedAt: thread.startedAt,
    completedAt: status === "running" ? null : thread.completedAt,
    sortAt: thread.startedAt ?? thread.createdAt,
    stop: status === "running" ? { type: "thread", threadId: thread.id } : null,
    children,
  };
}

function stopTargetForSubagent(
  subagent: ThreadAgentSubagentInput,
  status: string,
): ThreadAgentStopTarget | null {
  if (!RUNNING.has(status) || subagent.startedAt === null) return null;
  const nativeStoppable =
    subagent.origin === "provider_native" &&
    subagent.driver === "claudeAgent" &&
    subagent.runId !== null &&
    subagent.hasStrongNativeTask &&
    RUNNING.has(subagent.status);
  if (subagent.workflow !== undefined) {
    return subagent.origin === "provider_native" && subagent.driver === "claudeAgent"
      ? { type: "workflow", threadId: subagent.threadId, subagentId: subagent.id }
      : null;
  }
  if (nativeStoppable) {
    return { type: "subagent", threadId: subagent.threadId, subagentId: subagent.id };
  }
  if (subagent.origin === "app_owned" && subagent.childThreadId !== null) {
    return { type: "thread", threadId: subagent.childThreadId };
  }
  return null;
}

/**
 * Builds the roster for `threadId`. Children of a child conversation nest one
 * level below it; deeper descendants are reachable by opening that child.
 */
export function deriveThreadAgents(input: {
  readonly threadId: string;
  readonly subagents: ReadonlyArray<ThreadAgentSubagentInput>;
  readonly threads: ReadonlyArray<ThreadAgentThreadInput>;
}): ThreadAgentsSummary {
  const threadsById = new Map<string, ThreadAgentThreadInput>();
  for (const thread of input.threads) {
    if (!threadsById.has(thread.id)) threadsById.set(thread.id, thread);
  }
  const childrenOf = (parentId: string) =>
    [...threadsById.values()].filter(
      (thread) =>
        thread.id !== parentId &&
        ((thread.parentThreadId === parentId && thread.relationshipToParent === "subagent") ||
          thread.sourceThreadId === parentId),
    );
  const kindOf = (thread: ThreadAgentThreadInput, parentId: string): ThreadAgentKind =>
    thread.parentThreadId === parentId && thread.relationshipToParent === "subagent"
      ? "subagent"
      : "task";

  // Threads a subagent or workflow member already stands for, so they appear once.
  const claimed = new Set<string>([input.threadId]);
  for (const subagent of input.subagents) {
    if (subagent.childThreadId !== null) claimed.add(subagent.childThreadId);
    for (const member of subagent.workflow?.agents ?? []) {
      if (member.childThreadId !== undefined) claimed.add(member.childThreadId);
    }
  }

  const nestedThreadRows = (parentId: string, exclude: ReadonlySet<string>) =>
    childrenOf(parentId)
      .filter((thread) => !exclude.has(thread.id))
      .map((thread) => threadRow(thread, kindOf(thread, parentId), []));

  const rows: ThreadAgentRow[] = [];
  for (const subagent of input.subagents) {
    const child =
      subagent.childThreadId === null ? undefined : threadsById.get(subagent.childThreadId);
    // The child conversation is the live record once it has run, including
    // follow-ups after the original task settled.
    const rawStatus = child?.hasRun ? child.status : subagent.status;
    const status = resolveThreadAgentStatus(rawStatus);
    const memberRows: ThreadAgentRow[] = (subagent.workflow?.agents ?? []).map((member) => {
      const memberRaw =
        (member.state === "queued" || member.state === "running") && !RUNNING.has(subagent.status)
          ? subagent.status
          : member.state;
      const memberStatus = resolveThreadAgentStatus(memberRaw);
      const startedAt = isoFromMillis(member.startedAt);
      const completedAt =
        memberStatus === "running"
          ? null
          : member.startedAt !== undefined && member.durationMs !== undefined
            ? isoFromMillis(member.startedAt + member.durationMs)
            : null;
      return {
        key: `subagent:${subagent.id}:agent:${member.index}`,
        kind: "workflow_member",
        title: member.label,
        status: memberStatus,
        statusLabel: threadAgentStatusLabel(memberRaw),
        driver: subagent.driver,
        providerInstanceId: subagent.providerInstanceId,
        threadId: member.childThreadId ?? null,
        startedAt,
        completedAt,
        sortAt: startedAt ?? isoFromMillis(member.queuedAt) ?? subagent.updatedAt,
        stop: null,
        children: [],
      } satisfies ThreadAgentRow;
    });
    const nested =
      subagent.childThreadId === null
        ? []
        : nestedThreadRows(subagent.childThreadId, new Set([...claimed, input.threadId]));
    const liveStart = child?.hasRun ? (child.startedAt ?? subagent.startedAt) : subagent.startedAt;
    rows.push({
      key: `subagent:${subagent.id}`,
      kind: subagent.workflow === undefined ? "subagent" : "workflow",
      title: subagentTitle(subagent, child?.title),
      status,
      statusLabel: threadAgentStatusLabel(rawStatus),
      driver: subagent.driver,
      providerInstanceId: subagent.providerInstanceId,
      threadId: subagent.childThreadId,
      startedAt: liveStart,
      completedAt:
        status === "running"
          ? null
          : child?.hasRun
            ? (child.completedAt ?? subagent.completedAt)
            : subagent.completedAt,
      sortAt: liveStart ?? subagent.startedAt ?? child?.createdAt ?? subagent.updatedAt,
      stop: stopTargetForSubagent(subagent, rawStatus),
      children: sortThreadAgentRows([...memberRows, ...nested]),
    });
  }

  for (const thread of childrenOf(input.threadId)) {
    if (claimed.has(thread.id)) continue;
    claimed.add(thread.id);
    const nested = nestedThreadRows(thread.id, new Set([...claimed, input.threadId]));
    rows.push(threadRow(thread, kindOf(thread, input.threadId), sortThreadAgentRows(nested)));
  }

  const sorted = sortThreadAgentRows(rows);
  const flat = sorted.flatMap((row) => [row, ...row.children]);
  return {
    rows: sorted,
    total: flat.length,
    failed: flat.filter((row) => row.status === "failed").length,
    running: flat.filter((row) => row.status === "running").length,
  };
}

/** Long rosters show this many top-level rows until the user asks for all. */
export const THREAD_AGENTS_VISIBLE_CAP = 50;

export function resolveThreadAgentsWindow<Row>(
  rows: ReadonlyArray<Row>,
  showAll: boolean,
  cap: number = THREAD_AGENTS_VISIBLE_CAP,
): { readonly visible: ReadonlyArray<Row>; readonly hiddenCount: number } {
  if (showAll || rows.length <= cap) return { visible: rows, hiddenCount: 0 };
  return { visible: rows.slice(0, cap), hiddenCount: rows.length - cap };
}

export function formatThreadAgentsHeading(summary: Pick<ThreadAgentsSummary, "total" | "failed">) {
  const base = `Agents (${summary.total})`;
  return summary.failed > 0 ? `${base} · ${summary.failed} failed` : base;
}

/**
 * A row in the subagent rows' status language: in-flight rows shimmer and
 * leave the status column empty, settled rows get one glyph. The finer labels
 * the glyph cannot carry (Queued, Waiting, Idle) become the row's secondary text.
 */
export function threadAgentRowStatus(row: Pick<ThreadAgentRow, "status" | "statusLabel">): {
  readonly outcome: SubagentOutcome;
  readonly note: string | null;
} {
  const note =
    row.statusLabel === "Queued" || row.statusLabel === "Waiting" || row.statusLabel === "Idle"
      ? row.statusLabel
      : null;
  switch (row.status) {
    case "running":
      return { outcome: "working", note };
    case "failed":
      return { outcome: "failed", note: null };
    case "cancelled":
      return { outcome: "stopped", note: null };
    case "done":
      return row.statusLabel === "Idle"
        ? { outcome: "idle", note }
        : { outcome: "done", note: null };
  }
}

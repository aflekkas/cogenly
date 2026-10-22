// The timeline subagent row's decisions, after T3 Code (MIT,
// https://github.com/pingdotgg/t3code) apps/web/src/components/chat/V2LifecycleRow.tsx
// and V2LifecycleRow.logic.ts.
import type { OrchestrationV2TurnItemStatus } from "@t3tools/contracts";
import { markdownPreviewText } from "@t3tools/client-runtime/work-log/reasoning-text";

import type { BadgeDotTone } from "../ui/badge-dot";

const STATUS_VISUALS: Record<
  OrchestrationV2TurnItemStatus,
  { readonly tone: BadgeDotTone; readonly label: string }
> = {
  pending: { tone: "info", label: "Queued" },
  running: { tone: "info", label: "Running" },
  waiting: { tone: "info", label: "Waiting" },
  idle: { tone: "muted", label: "Idle · resumable" },
  completed: { tone: "success", label: "Completed" },
  failed: { tone: "destructive", label: "Failed" },
  cancelled: { tone: "muted", label: "Stopped" },
  interrupted: { tone: "muted", label: "Stopped" },
};

/** The status dot's colour and the words for a subagent's status. */
export function subagentStatusVisual(status: OrchestrationV2TurnItemStatus) {
  return STATUS_VISUALS[status];
}

const SETTLED = new Set<OrchestrationV2TurnItemStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const ACTIVE = new Set<OrchestrationV2TurnItemStatus>(["pending", "running", "waiting"]);

/** The server's placeholder when a child ends without output; the status dot already says it. */
const GENERIC_CHILD_END = /^Child task ended with status\b/i;

/**
 * The row's two lines. The second line is the latest progress while the agent
 * works and its result once settled, as plain text; with nothing to show it
 * carries the status instead. When there is a detail, the status moves up
 * beside the title, except for a plain completion, which the dot already says.
 */
export function subagentRowLines(input: {
  readonly status: OrchestrationV2TurnItemStatus | null;
  readonly liveStatus: OrchestrationV2TurnItemStatus;
  readonly statusLabel: string;
  readonly result: string | null | undefined;
  readonly progress: string | null | undefined;
  /** True when the row draws a past event (a notification) rather than live state. */
  readonly event: boolean;
}): { readonly detail: string | null; readonly titleStatus: string | null } {
  const result = input.result?.trim() ?? "";
  const progress = input.progress?.trim() ?? "";
  const settled = SETTLED.has(input.status ?? input.liveStatus);
  const raw = settled ? result || progress : progress || result;
  const detail = raw && !GENERIC_CHILD_END.test(raw) ? markdownPreviewText(raw) || null : null;
  const titleStatus =
    detail !== null && (input.event || input.status !== "completed") ? input.statusLabel : null;
  return { detail, titleStatus };
}

/**
 * Whether a subagent started another run after a notification reported its
 * final outcome, so that outcome no longer describes it. An active subagent is
 * always on a later run; a settled one is when it started after the
 * notification arrived.
 */
export function subagentResumedSince(
  agent: { readonly status: OrchestrationV2TurnItemStatus; readonly startedAt: string | null },
  notifiedAt: string,
): boolean {
  if (ACTIVE.has(agent.status)) return true;
  if (agent.startedAt === null) return false;
  const notifiedAtMillis = Date.parse(notifiedAt);
  return !Number.isNaN(notifiedAtMillis) && Date.parse(agent.startedAt) > notifiedAtMillis;
}

/**
 * The record that stands for a child conversation. Every follow-up delegated
 * to the same child records another subagent for it; the latest is the live one.
 */
export function latestSubagentForChild<Agent extends { readonly childThreadId: string | null }>(
  agents: ReadonlyArray<Agent>,
  childThreadId: string,
  /** When the record last began, in epoch ms: its start, else its last update. */
  startedAtMs: (agent: Agent) => number,
): Agent | null {
  let latest: Agent | null = null;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const agent of agents) {
    if (agent.childThreadId !== childThreadId) continue;
    const at = startedAtMs(agent);
    if (latest === null || at >= latestAt) {
      latest = agent;
      latestAt = at;
    }
  }
  return latest;
}

import type { OrchestrationV2TurnItemStatus } from "@t3tools/contracts";
import { summarizeSubagentStatuses } from "@t3tools/client-runtime/state/subagent-display";

/**
 * The few outcomes a subagent row distinguishes. In-flight states all read as
 * working (the title shimmers; the detail line says what it is doing), and
 * only settled states get a glyph in the row's status column.
 */
export type SubagentOutcome = "working" | "done" | "failed" | "stopped" | "idle";

export function subagentOutcome(status: OrchestrationV2TurnItemStatus): SubagentOutcome {
  switch (status) {
    case "pending":
    case "running":
    case "waiting":
      return "working";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "idle":
      return "idle";
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
}

/** Header text for a turn's subagents: "3 subagents · 2 working · 1 done". */
export function subagentGroupLabel(statuses: ReadonlyArray<OrchestrationV2TurnItemStatus>) {
  const count = `${statuses.length} ${statuses.length === 1 ? "subagent" : "subagents"}`;
  const summary = summarizeSubagentStatuses(statuses);
  return { count, summary, text: summary ? `${count} · ${summary}` : count };
}

/**
 * What a row's leading glyph shows: the one provider every member shares, or
 * nothing in particular when they differ.
 */
export function sharedSubagentDriver<Driver>(drivers: ReadonlyArray<Driver>): Driver | undefined {
  const [first] = drivers;
  if (first === undefined) return undefined;
  return drivers.every((driver) => driver === first) ? first : undefined;
}

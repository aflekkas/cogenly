import type { KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import type { TerminalSessionStatus } from "@t3tools/contracts";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";

const AGENT_LABEL_PREFIX = "agent · ";

export function isAgentTerminalId(terminalId: string): boolean {
  return terminalId.startsWith("agent-");
}

export interface AgentTerminalEntry {
  readonly terminalId: string;
  readonly isAgent: boolean;
  /** The command for agent terminals; the server's title for anything else. */
  readonly label: string;
  readonly status: TerminalSessionStatus;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly sortKey: string;
}

/** The thread's terminals, newest first. Agent commands sort by when they started. */
export function agentTerminalEntries(
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<AgentTerminalEntry> {
  return sessions
    .flatMap((session): AgentTerminalEntry[] => {
      const summary = session.state.summary;
      if (!summary) return [];
      const label = resolveTerminalSessionLabel(summary.terminalId, summary);
      const isAgent = isAgentTerminalId(summary.terminalId);
      return [
        {
          terminalId: summary.terminalId,
          isAgent,
          label:
            isAgent && label.startsWith(AGENT_LABEL_PREFIX)
              ? label.slice(AGENT_LABEL_PREFIX.length)
              : label,
          status: summary.status,
          exitCode: summary.exitCode,
          exitSignal: summary.exitSignal,
          cwd: summary.cwd,
          worktreePath: summary.worktreePath,
          sortKey: summary.startedAt ?? summary.updatedAt,
        },
      ];
    })
    .toSorted(
      (left, right) =>
        right.sortKey.localeCompare(left.sortKey) ||
        left.terminalId.localeCompare(right.terminalId),
    );
}

export function isAgentTerminalRunning(entry: Pick<AgentTerminalEntry, "status">): boolean {
  return entry.status === "running" || entry.status === "starting";
}

/** Short status for a finished terminal, e.g. "exit 0", "killed". */
export function agentTerminalExitLabel(
  entry: Pick<AgentTerminalEntry, "status" | "exitCode" | "exitSignal">,
): string {
  if (entry.status === "error") return "failed";
  if (entry.exitCode !== null) return `exit ${entry.exitCode}`;
  return entry.exitSignal !== null ? "killed" : "stopped";
}

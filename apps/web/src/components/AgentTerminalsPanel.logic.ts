import type { KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import type { TerminalSessionStatus, TerminalSummary } from "@t3tools/contracts";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";

const AGENT_LABEL_PREFIX = "agent · ";

export function isAgentTerminalId(terminalId: string): boolean {
  return terminalId.startsWith("agent-");
}

/** Who started a terminal: a command the agent ran, or a shell opened for the thread. */
export type AgentTerminalOwner = "agent" | "shell";

export interface AgentTerminalEntry {
  readonly terminalId: string;
  readonly owner: AgentTerminalOwner;
  readonly isAgent: boolean;
  /** The command for agent terminals; the server's title for anything else. */
  readonly label: string;
  readonly status: TerminalSessionStatus;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
  readonly hasRunningSubprocess: boolean;
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
          owner: isAgent ? "agent" : "shell",
          isAgent,
          label:
            isAgent && label.startsWith(AGENT_LABEL_PREFIX)
              ? label.slice(AGENT_LABEL_PREFIX.length)
              : label,
          status: summary.status,
          exitCode: summary.exitCode,
          exitSignal: summary.exitSignal,
          hasRunningSubprocess: summary.hasRunningSubprocess,
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

/**
 * What actually happened to a terminal's process. A signal wins over the exit
 * code: node-pty reports a signalled process with a (meaningless) code of 0.
 */
export type TerminalRunState =
  | { readonly kind: "starting" }
  | { readonly kind: "running" }
  /** A shell that is alive but has no foreground command. */
  | { readonly kind: "idle" }
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly exitCode: number }
  | { readonly kind: "killed"; readonly signal: number }
  /** The process never started. */
  | { readonly kind: "error" }
  /** Exited without reporting a code or signal. */
  | { readonly kind: "ended" };

export type TerminalRunTone = "live" | "muted" | "success" | "danger";

export function terminalRunState(
  terminal: Pick<TerminalSummary, "status" | "exitCode" | "exitSignal"> & {
    readonly hasRunningSubprocess?: boolean;
    readonly owner?: AgentTerminalOwner;
  },
): TerminalRunState {
  switch (terminal.status) {
    case "starting":
      return { kind: "starting" };
    case "running":
      return terminal.owner === "shell" && terminal.hasRunningSubprocess === false
        ? { kind: "idle" }
        : { kind: "running" };
    case "error":
      return { kind: "error" };
    case "exited":
      if (terminal.exitSignal !== null && terminal.exitSignal > 0) {
        return { kind: "killed", signal: terminal.exitSignal };
      }
      if (terminal.exitCode === 0) return { kind: "succeeded" };
      if (terminal.exitCode !== null) return { kind: "failed", exitCode: terminal.exitCode };
      return { kind: "ended" };
  }
}

const SIGNAL_NAMES: Readonly<Record<number, string>> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  6: "SIGABRT",
  9: "SIGKILL",
  13: "SIGPIPE",
  15: "SIGTERM",
};

export function terminalSignalName(signal: number): string {
  return SIGNAL_NAMES[signal] ?? `signal ${signal}`;
}

/** Short status for a row or header, e.g. "Running", "Exited 0", "Failed · code 2". */
export function terminalRunStateLabel(state: TerminalRunState): string {
  switch (state.kind) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "idle":
      return "Idle";
    case "succeeded":
      return "Exited 0";
    case "failed":
      return `Failed · code ${state.exitCode}`;
    case "killed":
      return `Killed · ${terminalSignalName(state.signal)}`;
    case "error":
      return "Failed to start";
    case "ended":
      return "Exited";
  }
}

/** The line written into the output once the process is gone. */
export function terminalRunStateMessage(state: TerminalRunState): string | null {
  switch (state.kind) {
    case "starting":
    case "running":
    case "idle":
      return null;
    case "succeeded":
      return "Process exited with code 0";
    case "failed":
      return `Process failed with exit code ${state.exitCode}`;
    case "killed":
      return `Process killed by ${terminalSignalName(state.signal)}`;
    case "error":
      return "Process failed to start";
    case "ended":
      return "Process exited";
  }
}

export function terminalRunStateTone(state: TerminalRunState): TerminalRunTone {
  switch (state.kind) {
    case "starting":
    case "running":
      return "live";
    case "idle":
    case "ended":
      return "muted";
    case "succeeded":
      return "success";
    case "failed":
    case "killed":
    case "error":
      return "danger";
  }
}

export interface AgentTerminalCounts {
  readonly total: number;
  readonly running: number;
  readonly failed: number;
}

export function agentTerminalCounts(
  entries: ReadonlyArray<AgentTerminalEntry>,
): AgentTerminalCounts {
  let running = 0;
  let failed = 0;
  for (const entry of entries) {
    const tone = terminalRunStateTone(terminalRunState(entry));
    if (tone === "live") running += 1;
    else if (tone === "danger") failed += 1;
  }
  return { total: entries.length, running, failed };
}

/**
 * Splits the list around the selected session so its output can sit directly
 * under its own row: rows above, the selected entry, rows below.
 */
export function splitAroundSelected<T extends { readonly terminalId: string }>(
  entries: ReadonlyArray<T>,
  selectedTerminalId: string | undefined,
): { before: ReadonlyArray<T>; selected: T | null; after: ReadonlyArray<T> } {
  const index = Math.max(
    0,
    entries.findIndex((entry) => entry.terminalId === selectedTerminalId),
  );
  const selected = entries[index] ?? null;
  if (!selected) return { before: [], selected: null, after: [] };
  return { before: entries.slice(0, index), selected, after: entries.slice(index + 1) };
}

import type { KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import type { TerminalSessionStatus, TerminalSummary } from "@t3tools/contracts";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";

import type { ScopeAccess } from "../state/scopeAccess";

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
  readonly hasRunningSubprocess: boolean;
  readonly cwd: string;
  readonly worktreePath: string | null;
  /** When an agent command started; null for a terminal the server did not time. */
  readonly startedAt: string | null;
  /** The last metadata change; for a finished command, roughly when it exited. */
  readonly updatedAt: string;
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
          hasRunningSubprocess: summary.hasRunningSubprocess,
          cwd: summary.cwd,
          worktreePath: summary.worktreePath,
          startedAt: summary.startedAt ?? null,
          updatedAt: summary.updatedAt,
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
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly exitCode: number }
  | { readonly kind: "killed"; readonly signal: number }
  /** The process never started. */
  | { readonly kind: "error" }
  /** Exited without reporting a code or signal. */
  | { readonly kind: "ended" };

export type TerminalRunTone = "live" | "muted" | "success" | "danger";

export function terminalRunState(
  terminal: Pick<TerminalSummary, "status" | "exitCode" | "exitSignal">,
): TerminalRunState {
  switch (terminal.status) {
    case "starting":
      return { kind: "starting" };
    case "running":
      return { kind: "running" };
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

export interface TerminalSections {
  /** Agent commands, live ones first, each group newest first. */
  readonly runs: ReadonlyArray<AgentTerminalEntry>;
  readonly liveRunCount: number;
}

/**
 * The agent's runs from a thread's terminals, in the panel's order. Expects
 * `agentTerminalEntries` order. Terminals the agent did not start (a shell
 * from an older client, say) are not the panel's business and are left out.
 */
export function terminalSections(entries: ReadonlyArray<AgentTerminalEntry>): TerminalSections {
  const live: AgentTerminalEntry[] = [];
  const finished: AgentTerminalEntry[] = [];
  for (const entry of entries) {
    if (!entry.isAgent) continue;
    if (isAgentTerminalRunning(entry)) live.push(entry);
    else finished.push(entry);
  }
  return { runs: [...live, ...finished], liveRunCount: live.length };
}

/**
 * What the composer's Running bar shows: the newest running agent command, or
 * a count once several run. Null when no agent command is running.
 */
export function runningAgentCommandsSummary(
  entries: ReadonlyArray<AgentTerminalEntry>,
): { readonly label: string; readonly terminalIds: ReadonlyArray<string> } | null {
  const { runs, liveRunCount } = terminalSections(entries);
  const live = runs.slice(0, liveRunCount);
  const newest = live[0];
  if (newest === undefined) return null;
  return {
    label: live.length === 1 ? newest.label : `${live.length} running`,
    terminalIds: live.map((entry) => entry.terminalId),
  };
}

/** The entry with `terminalId`, else the first one. */
export function resolveSelected<T extends { readonly terminalId: string }>(
  entries: ReadonlyArray<T>,
  terminalId: string | null | undefined,
): T | null {
  return entries.find((entry) => entry.terminalId === terminalId) ?? entries[0] ?? null;
}

/** The neighbour `step` rows away, clamped to the list; for arrow-key navigation. */
export function adjacentTerminalId(
  entries: ReadonlyArray<{ readonly terminalId: string }>,
  terminalId: string | null,
  step: number,
): string | null {
  if (entries.length === 0) return null;
  const index = entries.findIndex((entry) => entry.terminalId === terminalId);
  const next = index === -1 ? 0 : Math.min(entries.length - 1, Math.max(0, index + step));
  return entries[next]!.terminalId;
}

// Commands that only set up the real one: `cd dir`, `export X=1`, `set -e`, `source env`.
const SETUP_COMMAND = /^(?:cd|pushd|export|set|source|\.|unset|ulimit|umask)(?:\s|$)/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+/;

function stripSetupPrefix(segment: string): string {
  let rest = segment.trim();
  for (;;) {
    const assignment = ENV_ASSIGNMENT.exec(rest);
    if (!assignment) return rest;
    rest = rest.slice(assignment[0].length);
  }
}

/**
 * A short title for an agent command: the first step that does real work.
 * `bash -lc '…'` is unwrapped, `cd`/`export`/env-assignment steps are skipped,
 * and a heredoc body is dropped. The server collapses newlines into spaces, so
 * a bare `cd dir next-command` is split after `cd`'s one argument.
 */
export function commandTitle(command: string): string {
  let text = commandDisplayText(command).trim();
  const heredoc = text.indexOf("<<");
  if (heredoc !== -1) text = text.slice(0, heredoc).trim();
  const segments = text
    .split(/\s*(?:&&|\|\||;)\s*/)
    .map(stripSetupPrefix)
    .filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (!SETUP_COMMAND.test(segment)) return segment;
    // `cd dir mkdir app` came from newline-separated lines: keep what follows the argument.
    const remainder = /^cd\s+(?:'[^']*'|"[^"]*"|\S+)\s+(\S[\s\S]*)$/.exec(segment)?.[1];
    if (remainder && !SETUP_COMMAND.test(remainder)) return stripSetupPrefix(remainder);
  }
  return segments.at(-1) ?? command.trim();
}

// CSI/OSC escape sequences, matched after ESC and BEL become their control
// pictures so the pattern holds no control characters. Dev servers colour banners.
const ANSI_PATTERN = /␛(?:\[[0-?]*[ -/]*[@-~]|\][^␇␛]*(?:␇|␛\\)|[@-Z\\-_])/g;

function stripAnsi(text: string): string {
  return text.replaceAll("\u001b", "␛").replaceAll("\u0007", "␇").replace(ANSI_PATTERN, "");
}

const LOCAL_URL_PATTERN =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2})(?::\d{2,5})?(?:\/[^\s"'`<>)\]]*)?/gi;
const PORT_PHRASE_PATTERN =
  /\b(?:listening|running|started|serving|server|available)\b[^\n]*?\b(?:on\s+)?port\s*:?\s*(\d{2,5})\b/i;

function normalizeLocalUrl(url: string): string {
  return url
    .replace(/[.,;:!?]+$/, "")
    .replace(/^(https?:\/\/)(?:0\.0\.0\.0|\[::\]|\[::1\])/i, "$1localhost");
}

/**
 * The address a dev server announced in its output, for the run's Open button.
 * Prefers a `Local:` line (Vite, Next, CRA) over network addresses, then any
 * loopback URL, then a "listening on port N" phrase.
 */
export function detectLocalServerUrl(output: string): string | null {
  const text = stripAnsi(output);
  let first: string | null = null;
  for (const line of text.split(/\r?\n|\r/)) {
    for (const match of line.matchAll(LOCAL_URL_PATTERN)) {
      const url = normalizeLocalUrl(match[0]);
      if (/\blocal\b/i.test(line) && /\/\/localhost|\/\/127\./i.test(url)) return url;
      first ??= url;
    }
  }
  if (first) return first;
  const port = PORT_PHRASE_PATTERN.exec(text)?.[1];
  return port ? `http://localhost:${port}` : null;
}

/** "<1s", "12s", "3m 05s", "1h 02m". */
export function formatRunDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 1000) return "<1s";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/**
 * How long a finished command ran. Live commands get no duration: a ticking
 * clock would repaint the list every second, so they show their start time.
 */
export function runDurationMs(
  entry: Pick<AgentTerminalEntry, "status" | "startedAt" | "updatedAt">,
): number | null {
  if (isAgentTerminalRunning(entry) || entry.startedAt === null) return null;
  const elapsed = Date.parse(entry.updatedAt) - Date.parse(entry.startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

/**
 * What the Terminal panel shows before (or instead of) the run list. A draft
 * has no server thread, so no agent can have run anything yet; a grant that is
 * not known yet is a connecting state, never a denial.
 */
export type AgentTerminalsPanelState =
  | "not-started"
  | "connecting"
  | "unreachable"
  | "denied"
  | "runs";

export function agentTerminalsPanelState(input: {
  readonly threadStarted: boolean;
  readonly readAccess: ScopeAccess;
  readonly sessionsLoaded: boolean;
}): AgentTerminalsPanelState {
  if (!input.threadStarted) return "not-started";
  switch (input.readAccess) {
    case "pending":
      return "connecting";
    case "unreachable":
      return "unreachable";
    case "denied":
      return "denied";
    case "granted":
      return input.sessionsLoaded ? "runs" : "connecting";
  }
}

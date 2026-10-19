import {
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  type KnownTerminalSession,
} from "@t3tools/client-runtime/state/terminal";
import { EnvironmentId, ThreadId, type TerminalSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentTerminalCounts,
  agentTerminalEntries,
  isAgentTerminalRunning,
  splitAroundSelected,
  terminalRunState,
  terminalRunStateLabel,
  terminalRunStateMessage,
} from "./AgentTerminalsPanel.logic";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");

function session(summary: Partial<TerminalSummary> & { terminalId: string }): KnownTerminalSession {
  const full: TerminalSummary = {
    threadId,
    cwd: "/repo",
    worktreePath: null,
    status: "running",
    pid: 42,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: summary.terminalId,
    updatedAt: "2026-10-16T10:00:00.000Z",
    ...summary,
  };
  return {
    target: { environmentId, threadId, terminalId: full.terminalId },
    state: combineTerminalSessionState(full, EMPTY_TERMINAL_BUFFER_STATE),
  };
}

describe("agentTerminalEntries", () => {
  it("lists commands newest first by start time and strips the agent prefix", () => {
    const entries = agentTerminalEntries([
      session({
        terminalId: "agent-old",
        label: "agent · echo hi && ls",
        startedAt: "2026-10-16T10:00:00.000Z",
        // Output after the newer command started must not reorder the list.
        updatedAt: "2026-10-16T10:05:00.000Z",
        status: "exited",
        exitCode: 0,
      }),
      session({
        terminalId: "agent-new",
        label: "agent · sleep 30",
        startedAt: "2026-10-16T10:01:00.000Z",
        updatedAt: "2026-10-16T10:01:00.000Z",
      }),
    ]);
    expect(entries.map((entry) => [entry.terminalId, entry.label])).toEqual([
      ["agent-new", "sleep 30"],
      ["agent-old", "echo hi && ls"],
    ]);
    expect(entries.every((entry) => entry.isAgent)).toBe(true);
  });

  it("keeps script terminals, labelled by the server", () => {
    const [entry] = agentTerminalEntries([session({ terminalId: "term-1", label: "bun dev" })]);
    expect(entry).toMatchObject({
      terminalId: "term-1",
      owner: "shell",
      isAgent: false,
      label: "bun dev",
    });
  });
});

describe("terminalRunState", () => {
  const finished = (exitCode: number | null, exitSignal: number | null) =>
    terminalRunState({ status: "exited", exitCode, exitSignal });

  it("treats starting and running as live", () => {
    expect(isAgentTerminalRunning({ status: "starting" })).toBe(true);
    expect(isAgentTerminalRunning({ status: "running" })).toBe(true);
    expect(isAgentTerminalRunning({ status: "exited" })).toBe(false);
  });

  it("labels how a command finished", () => {
    expect(terminalRunStateLabel(finished(0, null))).toBe("Exited 0");
    expect(terminalRunStateLabel(finished(2, null))).toBe("Failed · code 2");
    expect(terminalRunStateLabel(finished(null, 9))).toBe("Killed · SIGKILL");
    expect(terminalRunStateLabel(finished(null, null))).toBe("Exited");
    expect(
      terminalRunStateLabel(
        terminalRunState({ status: "error", exitCode: null, exitSignal: null }),
      ),
    ).toBe("Failed to start");
  });

  it("reports a signalled process as killed even when node-pty sends code 0", () => {
    expect(finished(0, 15)).toEqual({ kind: "killed", signal: 15 });
    expect(terminalRunStateMessage(finished(0, 15))).toBe("Process killed by SIGTERM");
  });

  it("ignores a zero signal on a normal exit", () => {
    expect(finished(0, 0)).toEqual({ kind: "succeeded" });
    expect(finished(1, 0)).toEqual({ kind: "failed", exitCode: 1 });
  });

  it("names unknown signals by number", () => {
    expect(terminalRunStateLabel(finished(null, 31))).toBe("Killed · signal 31");
  });

  it("writes an exit line only once the process is gone", () => {
    expect(
      terminalRunStateMessage(
        terminalRunState({ status: "running", exitCode: null, exitSignal: null }),
      ),
    ).toBeNull();
    expect(terminalRunStateMessage(finished(0, null))).toBe("Process exited with code 0");
    expect(terminalRunStateMessage(finished(127, null))).toBe("Process failed with exit code 127");
  });

  it("shows an alive shell without a foreground command as idle", () => {
    const shell = { status: "running", exitCode: null, exitSignal: null, owner: "shell" } as const;
    expect(terminalRunState({ ...shell, hasRunningSubprocess: false })).toEqual({ kind: "idle" });
    expect(terminalRunState({ ...shell, hasRunningSubprocess: true })).toEqual({ kind: "running" });
    // An agent command is its own process, so it is running regardless.
    expect(terminalRunState({ ...shell, owner: "agent", hasRunningSubprocess: false })).toEqual({
      kind: "running",
    });
  });
});

describe("agentTerminalCounts", () => {
  it("counts live and failed sessions", () => {
    const entries = agentTerminalEntries([
      session({ terminalId: "agent-a", status: "running" }),
      session({ terminalId: "agent-b", status: "exited", exitCode: 0 }),
      session({ terminalId: "agent-c", status: "exited", exitCode: 1 }),
      session({ terminalId: "agent-d", status: "exited", exitCode: 0, exitSignal: 15 }),
      session({ terminalId: "term-1", status: "running", hasRunningSubprocess: false }),
    ]);
    expect(agentTerminalCounts(entries)).toEqual({ total: 5, running: 1, failed: 2 });
  });
});

describe("splitAroundSelected", () => {
  const entries = [{ terminalId: "a" }, { terminalId: "b" }, { terminalId: "c" }];

  it("puts the selected session between the rows above and below it", () => {
    expect(splitAroundSelected(entries, "b")).toEqual({
      before: [{ terminalId: "a" }],
      selected: { terminalId: "b" },
      after: [{ terminalId: "c" }],
    });
  });

  it("falls back to the newest session when the selection is gone", () => {
    expect(splitAroundSelected(entries, "missing").selected).toEqual({ terminalId: "a" });
    expect(splitAroundSelected(entries, undefined).before).toEqual([]);
  });

  it("is empty without sessions", () => {
    expect(splitAroundSelected([], "a")).toEqual({ before: [], selected: null, after: [] });
  });
});

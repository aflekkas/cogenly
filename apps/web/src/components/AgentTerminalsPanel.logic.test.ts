import {
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  type KnownTerminalSession,
} from "@t3tools/client-runtime/state/terminal";
import { EnvironmentId, ThreadId, type TerminalSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentTerminalEntries,
  agentTerminalExitLabel,
  isAgentTerminalRunning,
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
    expect(entry).toMatchObject({ terminalId: "term-1", isAgent: false, label: "bun dev" });
  });
});

describe("agent terminal status", () => {
  it("treats starting and running as live", () => {
    expect(isAgentTerminalRunning({ status: "starting" })).toBe(true);
    expect(isAgentTerminalRunning({ status: "running" })).toBe(true);
    expect(isAgentTerminalRunning({ status: "exited" })).toBe(false);
  });

  it("labels how a command finished", () => {
    expect(agentTerminalExitLabel({ status: "exited", exitCode: 0, exitSignal: null })).toBe(
      "exit 0",
    );
    expect(agentTerminalExitLabel({ status: "exited", exitCode: 2, exitSignal: null })).toBe(
      "exit 2",
    );
    expect(agentTerminalExitLabel({ status: "exited", exitCode: null, exitSignal: 9 })).toBe(
      "killed",
    );
    expect(agentTerminalExitLabel({ status: "error", exitCode: null, exitSignal: null })).toBe(
      "failed",
    );
  });
});

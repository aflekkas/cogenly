import {
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  type KnownTerminalSession,
} from "@cogenly/client-runtime/state/terminal";
import { EnvironmentId, ThreadId, type TerminalSummary } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  adjacentTerminalId,
  agentTerminalEntries,
  agentTerminalsPanelState,
  commandTitle,
  detectLocalServerUrl,
  formatRunDuration,
  isAgentTerminalRunning,
  runDurationMs,
  terminalRunState,
  terminalRunStateMessage,
  terminalSections,
  terminalSignalName,
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

  it("keeps terminals the agent did not start, labelled by the server", () => {
    const [entry] = agentTerminalEntries([session({ terminalId: "term-1", label: "bun dev" })]);
    expect(entry).toMatchObject({
      terminalId: "term-1",
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

  it("reports a signalled process as killed even when node-pty sends code 0", () => {
    expect(finished(0, 15)).toEqual({ kind: "killed", signal: 15 });
    expect(terminalRunStateMessage(finished(0, 15))).toBe("Process killed by SIGTERM");
  });

  it("ignores a zero signal on a normal exit", () => {
    expect(finished(0, 0)).toEqual({ kind: "succeeded" });
    expect(finished(1, 0)).toEqual({ kind: "failed", exitCode: 1 });
  });

  it("names unknown signals by number", () => {
    expect(terminalSignalName(9)).toBe("SIGKILL");
    expect(terminalSignalName(31)).toBe("signal 31");
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
});

describe("terminalSections", () => {
  it("pins live runs above finished ones and leaves out terminals the agent did not start", () => {
    const sections = terminalSections(
      agentTerminalEntries([
        session({
          terminalId: "agent-old-live",
          startedAt: "2026-10-16T09:00:00.000Z",
          status: "running",
        }),
        session({
          terminalId: "agent-new-done",
          startedAt: "2026-10-16T10:00:00.000Z",
          status: "exited",
          exitCode: 0,
        }),
        session({
          terminalId: "agent-mid-failed",
          startedAt: "2026-10-16T09:30:00.000Z",
          status: "exited",
          exitCode: 1,
        }),
        session({ terminalId: "term-10", updatedAt: "2026-10-16T08:00:00.000Z" }),
        session({ terminalId: "term-2", updatedAt: "2026-10-16T11:00:00.000Z" }),
      ]),
    );
    expect(sections.runs.map((entry) => entry.terminalId)).toEqual([
      "agent-old-live",
      "agent-new-done",
      "agent-mid-failed",
    ]);
    expect(sections.liveRunCount).toBe(1);
    expect(sections).not.toHaveProperty("shells");
  });
});

describe("adjacentTerminalId", () => {
  const entries = [{ terminalId: "a" }, { terminalId: "b" }, { terminalId: "c" }];

  it("moves by step and stops at either end", () => {
    expect(adjacentTerminalId(entries, "b", 1)).toBe("c");
    expect(adjacentTerminalId(entries, "c", 1)).toBe("c");
    expect(adjacentTerminalId(entries, "b", -5)).toBe("a");
    expect(adjacentTerminalId(entries, "missing", 1)).toBe("a");
    expect(adjacentTerminalId([], "a", 1)).toBeNull();
  });
});

describe("commandTitle", () => {
  it("skips directory and environment setup", () => {
    expect(commandTitle("cd /tmp/app && npm run dev")).toBe("npm run dev");
    expect(commandTitle("export CI=1; set -e; pnpm test --run")).toBe("pnpm test --run");
    expect(commandTitle("NODE_ENV=test FOO='a b' vitest run src")).toBe("vitest run src");
  });

  it("unwraps a shell -c wrapper", () => {
    expect(commandTitle(`bash -lc 'cd /repo && git status --short'`)).toBe("git status --short");
    expect(commandTitle(`/bin/zsh -c "make build"`)).toBe("make build");
  });

  it("drops heredoc bodies and splits newline-joined steps after cd", () => {
    expect(
      commandTitle(`cd /tmp/x mkdir app cat > package.json <<'EOF' { "name": "app" } EOF`),
    ).toBe("mkdir app cat > package.json");
  });

  it("finds the real step of a long command without cutting it", () => {
    expect(
      commandTitle(
        `export PATH="$PWD/node_modules/.bin:$PATH"; F="apps/web/src/components/preview/PreviewView.tsx; x"; vp lint "$F"`,
      ),
    ).toBe(`vp lint "$F"`);
    expect(
      commandTitle(
        "export PATH=$PWD/node_modules/.bin:$PATH\n# don't skip the tests\n(cd apps/web && vp test run packages/client-runtime/src/preview/serverBrowserStream.test.ts)",
      ),
    ).toBe("vp test run packages/client-runtime/src/preview/serverBrowserStream.test.ts");
    expect(commandTitle("(cd a && make) | tee log")).toBe("(cd a && make) | tee log");
  });

  it("keeps pipelines and falls back to the setup step when that is all there is", () => {
    expect(commandTitle("curl -s localhost:3000 | jq .status")).toBe(
      "curl -s localhost:3000 | jq .status",
    );
    expect(commandTitle("cd /tmp")).toBe("cd /tmp");
    expect(commandTitle("mktemp -d")).toBe("mktemp -d");
  });
});

describe("detectLocalServerUrl", () => {
  it("prefers the Local line of a dev server banner, ignoring colour codes", () => {
    const vite = [
      "\u001b[32m  VITE v6.0.0\u001b[39m  ready in 312 ms",
      "  \u001b[32m➜\u001b[39m  \u001b[1mNetwork\u001b[22m: http://192.168.1.20:5173/",
      "  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m",
    ].join("\r\n");
    expect(detectLocalServerUrl(vite)).toBe("http://localhost:5173/");
  });

  it("maps wildcard binds to localhost and trims punctuation", () => {
    expect(detectLocalServerUrl("Serving on http://0.0.0.0:8000.")).toBe("http://localhost:8000");
  });

  it("reads a bare listening port", () => {
    expect(detectLocalServerUrl("Server listening on port 4000")).toBe("http://localhost:4000");
  });

  it("ignores remote URLs and output without an address", () => {
    expect(detectLocalServerUrl("fetched https://example.com/api in 30ms")).toBeNull();
    expect(detectLocalServerUrl("added 212 packages in 3s")).toBeNull();
  });
});

describe("run durations", () => {
  it("formats compactly", () => {
    expect(formatRunDuration(400)).toBe("<1s");
    expect(formatRunDuration(12_300)).toBe("12s");
    expect(formatRunDuration(185_000)).toBe("3m 05s");
    expect(formatRunDuration(3_720_000)).toBe("1h 02m");
  });

  it("measures finished runs only", () => {
    const base = { startedAt: "2026-10-16T10:00:00.000Z", updatedAt: "2026-10-16T10:00:04.500Z" };
    expect(runDurationMs({ ...base, status: "exited" })).toBe(4_500);
    expect(runDurationMs({ ...base, status: "running" })).toBeNull();
    expect(runDurationMs({ ...base, startedAt: null, status: "exited" })).toBeNull();
  });
});

describe("agentTerminalsPanelState", () => {
  it("shows a draft as not started, whatever the grant", () => {
    for (const readAccess of ["granted", "denied", "pending", "unreachable"] as const) {
      expect(
        agentTerminalsPanelState({ threadStarted: false, readAccess, sessionsLoaded: false }),
      ).toBe("not-started");
    }
  });

  it("connects while the grant or the runs are still loading", () => {
    expect(
      agentTerminalsPanelState({
        threadStarted: true,
        readAccess: "pending",
        sessionsLoaded: false,
      }),
    ).toBe("connecting");
    expect(
      agentTerminalsPanelState({
        threadStarted: true,
        readAccess: "granted",
        sessionsLoaded: false,
      }),
    ).toBe("connecting");
  });

  it("reports a denial only when the grant says so", () => {
    expect(
      agentTerminalsPanelState({
        threadStarted: true,
        readAccess: "denied",
        sessionsLoaded: false,
      }),
    ).toBe("denied");
    expect(
      agentTerminalsPanelState({
        threadStarted: true,
        readAccess: "unreachable",
        sessionsLoaded: false,
      }),
    ).toBe("unreachable");
    expect(
      agentTerminalsPanelState({
        threadStarted: true,
        readAccess: "granted",
        sessionsLoaded: true,
      }),
    ).toBe("runs");
  });
});

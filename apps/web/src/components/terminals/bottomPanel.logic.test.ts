import { describe, expect, it } from "vite-plus/test";

import type { AgentTerminalEntry } from "../AgentTerminalsPanel.logic";
import {
  BOTTOM_PANEL_DEFAULT_HEIGHT,
  BOTTOM_PANEL_MIN_HEIGHT,
  bottomPanelMaxHeight,
  bottomPanelTabs,
  bottomPanelToggleShowsActivity,
  clampBottomPanelHeight,
  findRunForToolCall,
  resolveActiveBottomPanelTab,
} from "./bottomPanel.logic";

function run(
  terminalId: string,
  startedAt: string,
  overrides: Partial<AgentTerminalEntry> = {},
): AgentTerminalEntry {
  return {
    terminalId,
    isAgent: true,
    label: `echo ${terminalId}`,
    status: "exited",
    exitCode: 0,
    exitSignal: null,
    hasRunningSubprocess: false,
    cwd: "/repo",
    worktreePath: null,
    startedAt,
    updatedAt: startedAt,
    sortKey: startedAt,
    ...overrides,
  };
}

const primary = { threadId: "thread-1", title: "Agent" };
const reviewer = { threadId: "child-review", title: "Reviewer" };
const tester = { threadId: "child-test", title: "Tester" };

describe("bottomPanelTabs", () => {
  it("gives each agent that ran a command one tab, the thread's own agent first", () => {
    const tabs = bottomPanelTabs({
      primary,
      subagents: [tester, reviewer, { threadId: "child-idle", title: "Idle" }],
      entriesByThreadId: new Map([
        ["thread-1", [run("agent-3", "2026-10-21T10:03:00.000Z")]],
        // The tester ran first, so its tab stays left of the reviewer's.
        ["child-test", [run("agent-1", "2026-10-21T10:01:00.000Z")]],
        [
          "child-review",
          [
            run("agent-4", "2026-10-21T10:04:00.000Z", { status: "running", exitCode: null }),
            run("agent-2", "2026-10-21T10:02:00.000Z"),
          ],
        ],
      ]),
      hiddenTabs: undefined,
    });

    expect(tabs.map((tab) => [tab.id, tab.title, tab.liveRunCount])).toEqual([
      ["thread-1", "Agent", 0],
      ["child-test", "Tester", 0],
      ["child-review", "Reviewer", 1],
    ]);
    expect(tabs[0]!.primary).toBe(true);
    expect(tabs[2]!.runs.map((entry) => entry.terminalId)).toEqual(["agent-4", "agent-2"]);
  });

  it("leaves out the agent's own tab until it runs something, and shells it did not start", () => {
    const tabs = bottomPanelTabs({
      primary,
      subagents: [],
      entriesByThreadId: new Map([
        ["thread-1", [run("term-1", "2026-10-21T10:00:00.000Z", { isAgent: false })]],
      ]),
      hiddenTabs: undefined,
    });
    expect(tabs).toEqual([]);
  });

  it("keeps a closed tab hidden until its agent starts another command", () => {
    const entries = new Map([["child-test", [run("agent-1", "2026-10-21T10:01:00.000Z")]]]);
    const hiddenTabs = { "child-test": "2026-10-21T10:01:00.000Z" };
    expect(
      bottomPanelTabs({ primary, subagents: [tester], entriesByThreadId: entries, hiddenTabs }),
    ).toEqual([]);

    const afterNewRun = new Map([
      [
        "child-test",
        [
          run("agent-5", "2026-10-21T10:05:00.000Z", { status: "running", exitCode: null }),
          run("agent-1", "2026-10-21T10:01:00.000Z"),
        ],
      ],
    ]);
    const tabs = bottomPanelTabs({
      primary,
      subagents: [tester],
      entriesByThreadId: afterNewRun,
      hiddenTabs,
    });
    expect(tabs.map((tab) => tab.id)).toEqual(["child-test"]);
    expect(tabs[0]!.latestRunKey).toBe("2026-10-21T10:05:00.000Z");
  });
});

describe("bottom panel never opens for an agent", () => {
  it("only marks the header toggle while a command runs and the panel is closed", () => {
    const running = [{ liveRunCount: 1 }];
    expect(bottomPanelToggleShowsActivity(false, running)).toBe(true);
    expect(bottomPanelToggleShowsActivity(true, running)).toBe(false);
    expect(bottomPanelToggleShowsActivity(false, [{ liveRunCount: 0 }])).toBe(false);
  });
});

describe("resolveActiveBottomPanelTab", () => {
  it("falls back to the first tab when the stored one is gone", () => {
    const tabs = bottomPanelTabs({
      primary,
      subagents: [tester],
      entriesByThreadId: new Map([
        ["thread-1", [run("agent-1", "2026-10-21T10:01:00.000Z")]],
        ["child-test", [run("agent-2", "2026-10-21T10:02:00.000Z")]],
      ]),
      hiddenTabs: undefined,
    });
    expect(resolveActiveBottomPanelTab(tabs, "child-test")?.id).toBe("child-test");
    expect(resolveActiveBottomPanelTab(tabs, "child-gone")?.id).toBe("thread-1");
    expect(resolveActiveBottomPanelTab([], "thread-1")).toBeNull();
  });
});

describe("findRunForToolCall", () => {
  const tabs = [
    {
      id: "thread-1",
      runs: [
        run("agent-b", "2026-10-21T10:00:05.000Z", { label: "ls -la" }),
        run("agent-a", "2026-10-21T09:00:00.000Z", { label: "ls -la" }),
      ],
    },
    {
      id: "child-test",
      runs: [run("agent-c", "2026-10-21T10:00:01.000Z", { label: "pnpm test" })],
    },
  ];

  it("uses the terminal the tool result names", () => {
    expect(
      findRunForToolCall(tabs, {
        output: { content: [{ type: "text", text: '{"terminalId":"agent-c","status":"exited"}' }] },
        command: "something else",
        startedAt: "2026-10-21T10:00:00.000Z",
      }),
    ).toEqual({ tabId: "child-test", terminalId: "agent-c" });
  });

  it("matches the same command started closest after the call when the result is withheld", () => {
    expect(
      findRunForToolCall(tabs, {
        output: undefined,
        command: "ls -la",
        startedAt: "2026-10-21T10:00:04.000Z",
      }),
    ).toEqual({ tabId: "thread-1", terminalId: "agent-b" });
    expect(
      findRunForToolCall(tabs, {
        output: undefined,
        command: "rm -rf build",
        startedAt: "2026-10-21T10:00:04.000Z",
      }),
    ).toBeNull();
  });
});

describe("bottom panel height", () => {
  it("defaults like T3 Code's drawer and stays within the window and column", () => {
    expect(clampBottomPanelHeight(undefined, 1000)).toBe(BOTTOM_PANEL_DEFAULT_HEIGHT);
    expect(clampBottomPanelHeight(40, 1000)).toBe(BOTTOM_PANEL_MIN_HEIGHT);
    expect(clampBottomPanelHeight(900, 600)).toBe(600);
    expect(bottomPanelMaxHeight({ viewportHeight: 1000 })).toBe(750);
    expect(bottomPanelMaxHeight({ viewportHeight: 1000, columnHeight: 600 })).toBe(380);
    // A cramped window still leaves the panel its floor.
    expect(bottomPanelMaxHeight({ viewportHeight: 200, columnHeight: 200 })).toBe(
      BOTTOM_PANEL_MIN_HEIGHT,
    );
  });
});

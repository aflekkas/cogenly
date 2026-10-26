import type { EnvironmentThreadShell } from "@cogenly/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import { modeIndicators } from "./modeIndicators.logic";
import type { SidebarModeThreadClassifier } from "./sidebarModes.logic";

const NOW = "2026-03-09T12:00:00.000Z";
const classifier: SidebarModeThreadClassifier = {
  agentThreadKeys: new Set(),
  scratchProjectKeys: new Set(),
};
const capabilities = () => ({ threadSettlement: true, threadSnooze: true });

function thread(overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    environmentId: "env",
    id: "thread",
    projectId: "project",
    archivedAt: null,
    lineage: { relationshipToParent: null },
    source: { surface: "work" },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    runtime: null,
    interactionMode: "default",
    hasActionableProposedPlan: false,
    latestRun: null,
    settledOverride: null,
    snoozedUntil: null,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

type Input = Parameters<typeof modeIndicators>[0];

function indicators(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  agents: Input["agents"] = [],
  cap: Input["capabilities"] = capabilities,
) {
  return Object.fromEntries(
    modeIndicators({
      threads,
      classifier,
      agents,
      capabilities: cap,
      lastVisitedAt: (thread) => thread.lastVisitedAt ?? undefined,
      now: NOW,
    }),
  );
}

/** The modes whose dot says something waits on you. */
function attention(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  agents: Input["agents"] = [],
  cap: Input["capabilities"] = capabilities,
) {
  return Object.entries(indicators(threads, agents, cap))
    .filter(([, tone]) => tone === "warning")
    .map(([mode]) => mode)
    .toSorted();
}

const EARLIER = "2026-03-09T11:00:00.000Z";
/** A thread whose turn finished after its last visit: the row's blue dot. */
const unread = (overrides: Record<string, unknown> = {}) =>
  thread({
    lastVisitedAt: EARLIER,
    latestRun: { runId: "run", status: "completed", completedAt: NOW },
    ...overrides,
  });

describe("modeIndicators: unread", () => {
  it("lights a mode blue for a finished turn you have not seen", () => {
    expect(
      indicators([unread({ id: "chat", source: { surface: "chat" } }), unread({ id: "work" })]),
    ).toEqual({ chats: "info", tasks: "info" });
  });

  it("is quiet once the thread is visited after the reply, or was never tracked", () => {
    expect(indicators([unread({ lastVisitedAt: NOW })])).toEqual({});
    expect(indicators([unread({ lastVisitedAt: null })])).toEqual({});
  });

  it("shows amber over blue when the same mode also has something waiting", () => {
    expect(
      indicators([unread({ id: "a" }), thread({ id: "b", hasPendingApprovals: true })]),
    ).toEqual({ tasks: "warning" });
    expect(
      indicators([thread({ id: "b", hasPendingApprovals: true }), unread({ id: "a" })]),
    ).toEqual({ tasks: "warning" });
  });

  it("never lights a parent's mode for a subagent child's reply", () => {
    expect(
      indicators([unread({ id: "child", lineage: { relationshipToParent: "subagent" } })]),
    ).toEqual({});
  });

  it("ignores unread Work that is settled or snoozed", () => {
    expect(
      indicators([
        unread({ settledOverride: "settled" }),
        unread({ id: "napping", snoozedUntil: "2026-03-10T12:00:00.000Z" }),
      ]),
    ).toEqual({});
  });

  it("lights Agents blue for unread messages, amber for decisions", () => {
    const quiet = { approvals: [], requests: [], unreadCount: 0 };
    expect(indicators([], [quiet, { ...quiet, unreadCount: 2 }])).toEqual({ agents: "info" });
    expect(
      indicators(
        [],
        [
          { ...quiet, unreadCount: 2 },
          { ...quiet, approvals: [{}] },
        ],
      ),
    ).toEqual({ agents: "warning" });
  });
});

describe("modeIndicators: needs you", () => {
  it("files each thread's request under its own surface", () => {
    expect(
      attention([
        thread({ id: "chat", source: { surface: "chat" }, hasPendingUserInput: true }),
        thread({ id: "work", hasPendingApprovals: true }),
      ]),
    ).toEqual(["chats", "tasks"]);
    expect(attention([thread({ hasPendingApprovals: true })])).toEqual(["tasks"]);
    expect(
      attention([thread({ source: { surface: "chat" }, pendingSubagentRequest: "approval" })]),
    ).toEqual(["chats"]);
  });

  it("is quiet for a thread that is merely done or working", () => {
    expect(attention([thread({ runtime: { status: "running" } }), thread({ id: "idle" })])).toEqual(
      [],
    );
  });

  it("lights Work for a plan awaiting approval once its turn ended", () => {
    const plan = { interactionMode: "plan", hasActionableProposedPlan: true };
    const run = { runId: "run", status: "completed", completedAt: NOW };
    expect(
      attention([
        thread({ ...plan, latestRun: run, runtime: { status: "idle", activeRunId: null } }),
      ]),
    ).toEqual(["tasks"]);
    expect(
      attention([
        thread({
          ...plan,
          latestRun: { ...run, status: "running" },
          runtime: { status: "running", activeRunId: "run" },
        }),
      ]),
    ).toEqual([]);
  });

  it("ignores archived and subagent threads", () => {
    expect(
      attention([
        thread({ archivedAt: NOW, hasPendingApprovals: true }),
        thread({
          id: "child",
          lineage: { relationshipToParent: "subagent" },
          hasPendingApprovals: true,
        }),
      ]),
    ).toEqual([]);
  });

  it("ignores settled and snoozed Work, but a snoozed thread that asks wakes", () => {
    const later = "2026-03-10T12:00:00.000Z";
    expect(
      attention([
        thread({ settledOverride: "settled", hasPendingApprovals: true }),
        thread({ id: "napping", snoozedUntil: later }),
      ]),
    ).toEqual([]);
    expect(attention([thread({ snoozedUntil: later, hasPendingApprovals: true })])).toEqual([
      "tasks",
    ]);
  });

  it("parks threads only where the server supports it, and never parks chats", () => {
    expect(
      attention(
        [thread({ settledOverride: "settled", hasPendingApprovals: true })],
        [],
        () => ({}),
      ),
    ).toEqual(["tasks"]);
    expect(
      attention([
        thread({
          source: { surface: "chat" },
          settledOverride: "settled",
          hasPendingUserInput: true,
        }),
      ]),
    ).toEqual(["chats"]);
  });

  it("lights Agents for an agent with open decisions, not for its quiet conversation", () => {
    const quiet = { approvals: [], requests: [] };
    expect(attention([], [quiet, quiet])).toEqual([]);
    expect(attention([], [quiet, { approvals: [{}], requests: [] }])).toEqual(["agents"]);
    expect(attention([], [{ ...quiet, waitingInRun: true }])).toEqual(["agents"]);
    // The conversation thread is the Agents list's row, judged by the agent.
    expect(
      attention([
        thread({ source: { agent: { role: "conversation" } }, hasPendingUserInput: true }),
      ]),
    ).toEqual([]);
  });

  it("files an agent's Work under Work as well", () => {
    expect(
      attention([
        thread({ source: { agent: { role: "work" }, surface: "work" }, hasPendingApprovals: true }),
      ]),
    ).toEqual(["tasks"]);
  });
});

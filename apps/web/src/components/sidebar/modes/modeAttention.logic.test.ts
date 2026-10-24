import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import { modesNeedingAttention } from "./modeAttention.logic";
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

function attention(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  agents: Parameters<typeof modesNeedingAttention>[0]["agents"] = [],
  cap: Parameters<typeof modesNeedingAttention>[0]["capabilities"] = capabilities,
) {
  return [
    ...modesNeedingAttention({ threads, classifier, agents, capabilities: cap, now: NOW }),
  ].toSorted();
}

describe("modesNeedingAttention", () => {
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

import { describe, expect, it } from "vite-plus/test";

import {
  dedupeSubagents,
  deriveThreadAgents,
  formatThreadAgentsHeading,
  resolveThreadAgentsWindow,
  THREAD_AGENTS_INITIAL_COUNT,
  threadAgentDotTone,
  type ThreadAgentSubagentInput,
  type ThreadAgentThreadInput,
} from "./threadAgents.logic";

const OWNER = "thread-owner";

function subagent(
  id: string,
  overrides: Partial<ThreadAgentSubagentInput> = {},
): ThreadAgentSubagentInput {
  return {
    id,
    threadId: OWNER,
    origin: "app_owned",
    driver: "claudeAgent",
    providerInstanceId: "claude",
    childThreadId: null,
    runId: "run-1",
    hasStrongNativeTask: false,
    title: `Agent ${id}`,
    prompt: "do the thing",
    status: "completed",
    startedAt: "2026-10-20T10:00:00.000Z",
    completedAt: "2026-10-20T10:05:00.000Z",
    updatedAt: "2026-10-20T10:05:00.000Z",
    ...overrides,
  };
}

function thread(
  id: string,
  overrides: Partial<ThreadAgentThreadInput> = {},
): ThreadAgentThreadInput {
  return {
    id,
    title: `Thread ${id}`,
    providerInstanceId: "codex",
    parentThreadId: null,
    relationshipToParent: null,
    sourceThreadId: null,
    status: "completed",
    hasRun: true,
    startedAt: "2026-10-20T09:00:00.000Z",
    completedAt: "2026-10-20T09:10:00.000Z",
    createdAt: "2026-10-20T09:00:00.000Z",
    ...overrides,
  };
}

describe("deriveThreadAgents", () => {
  it("puts running agents on top and settled ones in previous, newest first", () => {
    const summary = deriveThreadAgents({
      threadId: OWNER,
      subagents: [
        subagent("old", { startedAt: "2026-10-20T08:00:00.000Z" }),
        subagent("new", { startedAt: "2026-10-20T12:00:00.000Z" }),
        subagent("live", {
          status: "running",
          startedAt: "2026-10-20T07:00:00.000Z",
          completedAt: null,
        }),
        subagent("queued", { status: "pending", startedAt: null, completedAt: null }),
      ],
      threads: [],
    });
    expect(summary.active.map((row) => row.key)).toEqual(["subagent:queued", "subagent:live"]);
    expect(summary.previous.map((row) => row.key)).toEqual(["subagent:new", "subagent:old"]);
    expect(summary.active[1]?.completedAt).toBeNull();
    // Queued is in flight but not running.
    expect(summary.running).toBe(1);
    expect(formatThreadAgentsHeading(summary)).toBe("Lineage · 1 running");
  });

  it("counts failures among previous agents", () => {
    const summary = deriveThreadAgents({
      threadId: OWNER,
      subagents: [
        subagent("a", { status: "failed" }),
        subagent("b"),
        subagent("c", { status: "interrupted" }),
      ],
      threads: [],
    });
    expect(summary.total).toBe(3);
    expect(summary.failed).toBe(1);
    expect(summary.running).toBe(0);
    expect(summary.previous.map((row) => row.status).sort()).toEqual([
      "cancelled",
      "done",
      "failed",
    ]);
    expect(formatThreadAgentsHeading(summary)).toBe("Lineage");
  });

  it("lists a child once however many follow-ups were delegated to it", () => {
    // Regression: each follow-up to the same child conversation records another
    // subagent, and every record used to render as its own row.
    const followUps = Array.from({ length: 8 }, (_, index) =>
      subagent(`pane-${index}`, {
        childThreadId: "pane",
        status: index === 5 ? "running" : "completed",
        startedAt: `2026-10-20T1${index}:00:00.000Z`,
        updatedAt: `2026-10-20T1${index}:30:00.000Z`,
      }),
    );
    const summary = deriveThreadAgents({
      threadId: OWNER,
      subagents: [...followUps, subagent("pane-0", { childThreadId: "pane" })],
      threads: [
        thread("pane", {
          parentThreadId: OWNER,
          relationshipToParent: "subagent",
          startedAt: "2026-10-20T17:00:00.000Z",
        }),
      ],
    });
    const rows = [...summary.active, ...summary.previous];
    expect(rows.map((row) => row.key)).toEqual(["subagent:pane-7"]);
    expect(rows[0]?.threadId).toBe("pane");
    expect(summary.total).toBe(1);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it("shows only direct agents, never a child's own subagents", () => {
    const summary = deriveThreadAgents({
      threadId: OWNER,
      subagents: [
        subagent("b", { childThreadId: "child-b" }),
        // A projection row that belongs to the child, not this thread.
        subagent("deep", { threadId: "child-b", childThreadId: "grandchild" }),
      ],
      threads: [
        thread("child-b", { parentThreadId: OWNER, relationshipToParent: "subagent" }),
        thread("grandchild", { parentThreadId: "child-b", relationshipToParent: "subagent" }),
        thread("work-of-child", { sourceThreadId: "child-b" }),
      ],
    });
    const rows = [...summary.active, ...summary.previous];
    expect(rows.map((row) => row.threadId)).toEqual(["child-b"]);
    expect(rows[0]?.members).toEqual([]);
    expect(summary.total).toBe(1);
  });

  it("lists Work started from this thread and delegated child threads, not forks", () => {
    const summary = deriveThreadAgents({
      threadId: OWNER,
      subagents: [],
      threads: [
        thread(OWNER),
        thread("work", { sourceThreadId: OWNER }),
        thread("delegate", { parentThreadId: OWNER, relationshipToParent: "subagent" }),
        thread("fork", { parentThreadId: OWNER, relationshipToParent: "fork" }),
      ],
    });
    expect(summary.previous.map((row) => [row.threadId, row.kind]).sort()).toEqual([
      ["delegate", "subagent"],
      ["work", "task"],
    ]);
  });

  it("follows the child conversation once it has run, and only stops what can be stopped", () => {
    const summary = deriveThreadAgents({
      threadId: OWNER,
      subagents: [
        subagent("followup", { childThreadId: "child", status: "completed" }),
        subagent("native", {
          origin: "provider_native",
          status: "running",
          completedAt: null,
          hasStrongNativeTask: true,
        }),
        subagent("weak", {
          origin: "provider_native",
          status: "running",
          completedAt: null,
          hasStrongNativeTask: false,
        }),
      ],
      threads: [
        thread("child", {
          parentThreadId: OWNER,
          relationshipToParent: "subagent",
          status: "running",
          startedAt: "2026-10-20T11:00:00.000Z",
        }),
      ],
    });
    const byKey = new Map(summary.active.map((row) => [row.key, row]));
    expect(byKey.get("subagent:followup")?.status).toBe("running");
    expect(byKey.get("subagent:followup")?.stop).toEqual({ type: "thread", threadId: "child" });
    expect(byKey.get("subagent:native")?.stop).toEqual({
      type: "subagent",
      threadId: OWNER,
      subagentId: "native",
    });
    expect(byKey.get("subagent:weak")?.stop).toBeNull();
  });

  it("keeps workflow members on their coordinator, settling them with it", () => {
    const summary = deriveThreadAgents({
      threadId: OWNER,
      subagents: [
        subagent("wf", {
          status: "cancelled",
          workflow: {
            name: "Review",
            agents: [
              { index: 0, label: "Reader", state: "completed", startedAt: 1000, durationMs: 5000 },
              { index: 1, label: "Writer", state: "running", startedAt: 2000 },
            ],
          },
        }),
      ],
      threads: [],
    });
    const [workflow] = summary.previous;
    expect(workflow?.kind).toBe("workflow");
    expect(workflow?.title).toBe("Review");
    expect(workflow?.members.map((row) => [row.title, row.status])).toEqual([
      ["Writer", "cancelled"],
      ["Reader", "done"],
    ]);
    expect(summary.total).toBe(1);
  });
});

describe("dedupeSubagents", () => {
  it("keeps one record per id and per child conversation, the latest one", () => {
    const kept = dedupeSubagents([
      subagent("x", { childThreadId: "c", startedAt: "2026-10-20T10:00:00.000Z" }),
      subagent("y", { childThreadId: "c", startedAt: "2026-10-20T12:00:00.000Z" }),
      subagent("z", { childThreadId: "c", startedAt: null, updatedAt: "2026-10-20T11:00:00.000Z" }),
      subagent("native"),
      subagent("native"),
    ]);
    expect(kept.map((entry) => entry.id)).toEqual(["y", "native"]);
  });
});

describe("resolveThreadAgentsWindow", () => {
  it("shows the first page and counts the rest", () => {
    const rows = Array.from({ length: 247 }, (_, index) => index);
    expect(resolveThreadAgentsWindow(rows, THREAD_AGENTS_INITIAL_COUNT).visible).toHaveLength(6);
    expect(resolveThreadAgentsWindow(rows, THREAD_AGENTS_INITIAL_COUNT).hiddenCount).toBe(241);
    expect(resolveThreadAgentsWindow(rows, 300)).toEqual({ visible: rows, hiddenCount: 0 });
  });
});

describe("threadAgentDotTone", () => {
  it("colours in-flight, failed, done and resting agents apart", () => {
    expect(threadAgentDotTone({ status: "running", statusLabel: "Queued" })).toBeNull();
    expect(threadAgentDotTone({ status: "failed", statusLabel: "Failed" })).toBe("destructive");
    expect(threadAgentDotTone({ status: "done", statusLabel: "Done" })).toBe("success");
    expect(threadAgentDotTone({ status: "done", statusLabel: "Idle" })).toBe("muted");
    expect(threadAgentDotTone({ status: "cancelled", statusLabel: "Cancelled" })).toBe("muted");
  });
});

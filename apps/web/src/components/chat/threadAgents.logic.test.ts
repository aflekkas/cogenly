import { describe, expect, it } from "vite-plus/test";

import {
  deriveThreadAgents,
  formatThreadAgentsHeading,
  resolveThreadAgentsWindow,
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
  it("puts running agents first, then newest first", () => {
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
      ],
      threads: [],
    });
    expect(summary.rows.map((row) => row.key)).toEqual([
      "subagent:live",
      "subagent:new",
      "subagent:old",
    ]);
    expect(summary.rows[0]?.status).toBe("running");
    expect(summary.rows[0]?.completedAt).toBeNull();
  });

  it("counts every row, failures and running ones, nested rows included", () => {
    const summary = deriveThreadAgents({
      threadId: OWNER,
      subagents: [
        subagent("a", { status: "failed" }),
        subagent("b", { childThreadId: "child-b" }),
        subagent("c", { status: "interrupted" }),
      ],
      threads: [
        thread("child-b", { parentThreadId: OWNER, relationshipToParent: "subagent" }),
        thread("grandchild", {
          parentThreadId: "child-b",
          relationshipToParent: "subagent",
          status: "failed",
        }),
      ],
    });
    expect(summary.total).toBe(4);
    expect(summary.failed).toBe(2);
    expect(summary.running).toBe(0);
    expect(summary.rows.map((row) => row.status).sort()).toEqual(["cancelled", "done", "failed"]);
    expect(formatThreadAgentsHeading(summary)).toBe("Agents (4) · 2 failed");
  });

  it("nests a child's own agents one level and lists a subagent's thread once", () => {
    const summary = deriveThreadAgents({
      threadId: OWNER,
      subagents: [subagent("b", { childThreadId: "child-b" })],
      threads: [
        thread("child-b", { parentThreadId: OWNER, relationshipToParent: "subagent" }),
        thread("grandchild", { parentThreadId: "child-b", relationshipToParent: "subagent" }),
        thread("great", { parentThreadId: "grandchild", relationshipToParent: "subagent" }),
      ],
    });
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]?.threadId).toBe("child-b");
    expect(summary.rows[0]?.children.map((row) => row.threadId)).toEqual(["grandchild"]);
    expect(summary.rows[0]?.children[0]?.children).toEqual([]);
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
    expect(summary.rows.map((row) => [row.threadId, row.kind]).sort()).toEqual([
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
    const byKey = new Map(summary.rows.map((row) => [row.key, row]));
    expect(byKey.get("subagent:followup")?.status).toBe("running");
    expect(byKey.get("subagent:followup")?.stop).toEqual({ type: "thread", threadId: "child" });
    expect(byKey.get("subagent:native")?.stop).toEqual({
      type: "subagent",
      threadId: OWNER,
      subagentId: "native",
    });
    expect(byKey.get("subagent:weak")?.stop).toBeNull();
  });

  it("nests workflow members under their coordinator, settling them with it", () => {
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
    const [workflow] = summary.rows;
    expect(workflow?.kind).toBe("workflow");
    expect(workflow?.title).toBe("Review");
    expect(workflow?.children.map((row) => [row.title, row.status])).toEqual([
      ["Writer", "cancelled"],
      ["Reader", "done"],
    ]);
    expect(summary.total).toBe(3);
  });
});

describe("resolveThreadAgentsWindow", () => {
  it("caps long lists until all are requested", () => {
    const rows = Array.from({ length: 60 }, (_, index) => index);
    expect(resolveThreadAgentsWindow(rows, false).visible).toHaveLength(50);
    expect(resolveThreadAgentsWindow(rows, false).hiddenCount).toBe(10);
    expect(resolveThreadAgentsWindow(rows, true).visible).toHaveLength(60);
  });
});

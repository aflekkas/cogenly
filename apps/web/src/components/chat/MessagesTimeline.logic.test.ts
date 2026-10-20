import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import {
  collapseWorkEntryRuns,
  deriveMessagesTimelineRows,
  type TimelineLatestRun,
} from "./MessagesTimeline.logic";

const runId = RunId.make("run-reply");

function messageEntry(
  id: string,
  role: ChatMessage["role"],
  options: { streaming?: boolean; at: number },
): TimelineEntry {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, options.at)).toISOString();
  return {
    id,
    kind: "message",
    createdAt: timestamp,
    message: {
      id: MessageId.make(id),
      role,
      text: role === "user" ? "hey" : "Hey! What's up?",
      runId,
      streaming: options.streaming ?? false,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

const runningRun: TimelineLatestRun = {
  runId,
  status: "running",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
};
const completedRun: TimelineLatestRun = {
  ...runningRun,
  status: "completed",
  completedAt: "2026-01-01T00:00:05.000Z",
};

function rowsFor(entries: TimelineEntry[], working: boolean) {
  return deriveMessagesTimelineRows({
    timelineEntries: entries,
    latestRun: working ? runningRun : completedRun,
    runningRunId: working ? runId : null,
    isWorking: working,
    activeTurnStartedAt: working ? runningRun.startedAt : null,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  });
}

/** Everything that changes a row's height in the reply's turn. */
function layoutOf(rows: ReturnType<typeof rowsFor>) {
  return rows.map((row) =>
    row.kind === "message"
      ? `${row.message.role}${row.showAssistantMeta || row.showLiveActivity ? "+slot" : ""}`
      : row.kind,
  );
}

describe("reply-only turns keep their layout while they settle", () => {
  const user = messageEntry("user-1", "user", { at: 0 });

  it("shows the working header and activity before the reply arrives", () => {
    expect(layoutOf(rowsFor([user], true))).toEqual(["user", "working", "thinking"]);
  });

  it("puts the reply in the header's place, with activity in its metadata slot", () => {
    const rows = rowsFor(
      [user, messageEntry("reply-1", "assistant", { streaming: true, at: 1 })],
      true,
    );
    expect(layoutOf(rows)).toEqual(["user", "assistant+slot"]);
    const reply = rows.at(-1);
    expect(reply?.kind === "message" && reply.showLiveActivity).toBe(true);
  });

  it("keeps the same rows and slot once the turn settles", () => {
    const streaming = rowsFor(
      [user, messageEntry("reply-1", "assistant", { streaming: true, at: 1 })],
      true,
    );
    const settled = rowsFor([user, messageEntry("reply-1", "assistant", { at: 1 })], false);
    expect(layoutOf(settled)).toEqual(layoutOf(streaming));
    const reply = settled.at(-1);
    expect(reply?.kind === "message" && reply.showAssistantMeta).toBe(true);
    expect(reply?.kind === "message" && reply.showLiveActivity).toBeUndefined();
  });
});

describe("a collapsing tool group keeps its details until they animate out", () => {
  function searchEntry(id: string, at: number): TimelineEntry {
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, at)).toISOString();
    return {
      id,
      kind: "work",
      createdAt,
      entry: {
        id,
        createdAt,
        label: "Searched the web",
        detail: `query ${id}`,
        tone: "tool",
        itemType: "web_search",
        runId,
        toolLifecycleStatus: "completed",
      },
    };
  }
  const entries = [
    messageEntry("user-1", "user", { at: 0 }),
    searchEntry("search-1", 1),
    searchEntry("search-2", 2),
    messageEntry("reply-1", "assistant", { at: 3 }),
  ];
  const groupId = "work-group:search-1";
  const groupRows = (disclosure: {
    expandedWorkGroupIds?: ReadonlySet<string>;
    closingWorkGroupIds?: ReadonlySet<string>;
  }) =>
    deriveMessagesTimelineRows({
      timelineEntries: entries,
      latestRun: completedRun,
      expandedRunIds: new Set([runId]),
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      ...disclosure,
    }).filter((row) => row.kind === "work-toggle" || row.kind === "work");

  it("reads collapsed in the header while the details row stays, marked closing", () => {
    const [header, details] = groupRows({ closingWorkGroupIds: new Set([groupId]) });
    expect(header).toMatchObject({ kind: "work-toggle", expanded: false, closing: true });
    expect(details).toMatchObject({ kind: "work", groupId, closing: true });
  });

  it("drops the details once the close ends, and reopening clears closing", () => {
    expect(groupRows({}).map((row) => row.kind)).toEqual(["work-toggle"]);
    const reopened = groupRows({
      expandedWorkGroupIds: new Set([groupId]),
      closingWorkGroupIds: new Set([groupId]),
    });
    expect(reopened.map((row) => [row.kind, row.closing])).toEqual([
      ["work-toggle", undefined],
      ["work", undefined],
    ]);
  });
});

describe("collapseWorkEntryRuns", () => {
  const toolEntry = (id: string, toolName: string, input: unknown): WorkLogEntry => ({
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    label: toolName,
    tone: "tool",
    itemType: "dynamic_tool",
    toolLifecycleStatus: "completed",
    toolData: { toolName, input },
  });
  const thought: WorkLogEntry = {
    id: "thought",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Reasoning",
    detail: "**Preparing a read**",
    tone: "thinking",
    itemType: "reasoning",
  };

  it("collapses consecutive searches and keeps other rows in place", () => {
    const runs = collapseWorkEntryRuns([
      toolEntry("s1", "cogenly.search", { query: "a" }),
      toolEntry("s2", "mcp__cogenly__search", { query: "b" }),
      toolEntry("s3", "cogenly.t3_thread_search", { query: "c" }),
      thought,
      toolEntry("r1", "cogenly.t3_thread_read", { threadId: "t-1" }),
      toolEntry("x1", "Bash", { command: "ls" }),
    ]);
    expect(runs.map((run) => (run.kind === "run" ? run.label : run.id))).toEqual([
      "Searched chats ×3",
      "thought",
      "r1",
      "x1",
    ]);
    expect(runs[0]).toMatchObject({ kind: "run", id: "run:s1", icon: "search" });
  });
});

describe("a turn's delegations read as one subagent row", () => {
  const at = (second: number) => DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 0, 0, second));
  const base = (id: string, second: number) => ({
    id: TurnItemId.make(id),
    threadId: ThreadId.make("thread-parent"),
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: second,
    title: null,
    startedAt: at(second),
    completedAt: null,
    updatedAt: at(second),
  });
  const projected = (item: OrchestrationV2TurnItem): OrchestrationV2ProjectedTurnItem => ({
    position: item.ordinal,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  });
  const delegation = (id: string, second: number, task: string): TimelineEntry => {
    const item: OrchestrationV2TurnItem = {
      ...base(id, second),
      type: "dynamic_tool",
      status: "running",
      toolName: "mcp__cogenly__delegate_task",
      input: { task, mode: "wait" },
    };
    const createdAt = DateTime.formatIso(at(second));
    return {
      id,
      kind: "work",
      createdAt,
      entry: {
        id,
        createdAt,
        label: "Delegating a child task",
        tone: "tool",
        itemType: "dynamic_tool",
        runId,
        toolLifecycleStatus: "inProgress",
        projectedItem: projected(item),
        structuredPayload: item,
      },
    };
  };
  const child = (id: string, second: number, prompt: string): TimelineEntry => ({
    id,
    kind: "event",
    createdAt: DateTime.formatIso(at(second)),
    projectedItem: projected({
      ...base(id, second),
      type: "subagent",
      status: "running",
      subagentId: NodeId.make(`node-${id}`),
      origin: "app_owned",
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      childThreadId: ThreadId.make(`thread-${id}`),
      prompt,
      result: null,
    }),
  });

  it("hides running delegate rows that a child carries and groups the children", () => {
    const rows = rowsFor(
      [
        messageEntry("user-1", "user", { at: 0 }),
        delegation("d1", 1, "Render the bell"),
        child("c1", 2, "Render the bell"),
        delegation("d2", 3, "Find a cheaper tee"),
        child("c2", 4, "Act as the research sub-agent for this task.\n\nFind a cheaper tee"),
      ],
      true,
    );
    const events = rows.filter((row) => row.kind === "event");
    expect(events).toHaveLength(1);
    expect(events[0]?.kind === "event" && events[0].subagents?.map(({ item }) => item.id)).toEqual([
      "c1",
      "c2",
    ]);
    expect(
      rows.some(
        (row) =>
          (row.kind === "work" || row.kind === "work-live") &&
          row.groupedEntries.some((entry) => entry.id === "d1" || entry.id === "d2"),
      ),
    ).toBe(false);
  });
});

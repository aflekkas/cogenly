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
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { pendingSubagentCompletions } from "./pendingSubagentCompletions.logic";
import {
  collapseRestartMarkers,
  collapseWorkEntryRuns,
  createUserMessageArrivals,
  deriveMessagesTimelineRows,
  deriveTerminalAssistantMessageIds,
  disclosureOpenedRecently,
  markDisclosureClosed,
  markDisclosureOpened,
  recordUserMessageArrivals,
  resolveDisclosureHoldsEnd,
  turnFoldRowId,
  type DisclosureOpenTimes,
  type MessagesTimelineRow,
  type TimelineLatestRun,
} from "./MessagesTimeline.logic";

const runId = RunId.make("run-reply");

function messageEntry(
  id: string,
  role: ChatMessage["role"],
  options: { streaming?: boolean; at: number },
): Extract<TimelineEntry, { kind: "message" }> {
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

  describe("a collapsing turn fold keeps the work it reveals until it animates out", () => {
    const foldId = turnFoldRowId(runId);
    const foldRows = (disclosure: {
      expandedRunIds?: ReadonlySet<RunId>;
      closingFoldIds?: ReadonlySet<string>;
    }) =>
      deriveMessagesTimelineRows({
        timelineEntries: entries,
        latestRun: completedRun,
        isWorking: false,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        ...disclosure,
      }).map((row) => [row.kind, "expanded" in row ? row.expanded : null, row.foldReveal ?? null]);

    it("marks only the revealed work while the fold is open", () => {
      expect(foldRows({ expandedRunIds: new Set([runId]) })).toEqual([
        ["message", null, null],
        ["turn-fold", true, null],
        ["work-toggle", false, { foldId, closing: false }],
        ["message", null, null],
      ]);
    });

    it("reads collapsed while the revealed work stays, marked closing, then drops it", () => {
      expect(foldRows({ closingFoldIds: new Set([foldId]) })).toEqual([
        ["message", null, null],
        ["turn-fold", false, null],
        ["work-toggle", false, { foldId, closing: true }],
        ["message", null, null],
      ]);
      expect(foldRows({}).map(([kind]) => kind)).toEqual(["message", "turn-fold", "message"]);
    });
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
      toolEntry("s3", "cogenly.thread_search", { query: "c" }),
      thought,
      toolEntry("r1", "cogenly.thread_read", { threadId: "t-1" }),
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

describe("terminal reasoning", () => {
  const thinking: TimelineEntry = {
    id: "unfinished-thought",
    kind: "work",
    createdAt: runningRun.startedAt!,
    entry: {
      id: "unfinished-thought",
      createdAt: runningRun.startedAt!,
      runId,
      label: "Thinking",
      detail: "I should inspect the source.",
      itemType: "reasoning",
      tone: "thinking",
      toolLifecycleStatus: "inProgress",
    },
  };
  it.each(["completed", "failed", "cancelled", "interrupted"] as const)(
    "settles the last reasoning item when its run is %s without a final item event",
    (status) => {
      const rows = deriveMessagesTimelineRows({
        timelineEntries: [messageEntry("user", "user", { at: 0 }), thinking],
        latestRun: { ...completedRun, status },
        runningRunId: null,
        isWorking: false,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        expandedWorkGroupIds: new Set(["work-group:unfinished-thought"]),
      });
      expect(
        rows.some(
          (row) =>
            row.kind === "thinking" ||
            row.kind === "working" ||
            (row.kind === "work-live" && row.active),
        ),
      ).toBe(false);
      const entries = rows.flatMap((row) => (row.kind === "work" ? row.groupedEntries : []));
      expect(entries.every((entry) => entry.toolLifecycleStatus !== "inProgress")).toBe(true);
    },
  );

  it("keeps a running turn's last thought live, then settles it on supersession", () => {
    expect(rowsFor([thinking], true).some((row) => row.kind === "work-live" && row.active)).toBe(
      true,
    );
    const laterRun = { ...runningRun, runId: RunId.make("resumed-run") };
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        thinking,
        {
          ...messageEntry("later-prompt", "user", { at: 10 }),
          message: {
            ...messageEntry("later-prompt", "user", { at: 10 }).message,
            runId: laterRun.runId,
          },
        },
      ],
      latestRun: laterRun,
      runningRunId: laterRun.runId,
      isWorking: true,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(
      rows.some((row) => row.kind === "work-live" && row.entry.id === thinking.id && row.active),
    ).toBe(false);
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
  const child = (
    id: string,
    second: number,
    prompt: string,
    status: OrchestrationV2TurnItem["status"] = "running",
  ): Extract<TimelineEntry, { kind: "event" }> => ({
    id,
    kind: "event",
    createdAt: DateTime.formatIso(at(second)),
    projectedItem: projected({
      ...base(id, second),
      type: "subagent",
      status,
      subagentId: NodeId.make(`node-${id}`),
      origin: "app_owned",
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      childThreadId: ThreadId.make(`thread-${id}`),
      prompt,
      result: null,
    }),
  });

  it.each(["failed", "completed", "cancelled", "interrupted"] as const)(
    "keeps a %s delegated row before later messages",
    (status) => {
      const laterRunId = RunId.make("later-parent-run");
      const laterMessage = messageEntry("later-user", "user", { at: 50 });
      const rows = deriveMessagesTimelineRows({
        timelineEntries: [
          messageEntry("original-user", "user", { at: 0 }),
          child("old-child", 1, "Integration work", status),
          messageEntry("original-reply", "assistant", { at: 5 }),
          { ...laterMessage, message: { ...laterMessage.message, runId: laterRunId } },
        ],
        latestRun: { ...completedRun, runId: laterRunId },
        isWorking: false,
        expandedRunIds: new Set([runId]),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      const childIndex = rows.findIndex(
        (row) => row.kind === "event" && row.projectedItem.item.id === "old-child",
      );
      expect(childIndex).toBeGreaterThanOrEqual(0);
      expect(childIndex).toBeLessThan(
        rows.findIndex((row) => row.kind === "message" && row.message.id === "later-user"),
      );
      expect(rows.some((row) => row.kind === "thinking" || row.kind === "working")).toBe(false);
    },
  );

  it("keeps the old rate-limited Integrations task in history while Fork to VPS runs terminal commands", () => {
    const title = "Integrations revamp: core catalog only + click-to-configure setup";
    const failed = child("integrations-revamp", 1, title, "failed");
    const failure = {
      ...failed,
      projectedItem: {
        ...failed.projectedItem,
        item: {
          ...failed.projectedItem.item,
          title,
          completedAt: at(30),
          updatedAt: at(30),
          result: "Claude API rate limit reached. Try again later.",
        },
      },
    };
    const forkRunId = RunId.make("run:fork-to-vps");
    const prompt = messageEntry("fork-to-vps", "user", { at: 3_000 });
    const comment = messageEntry("launch-anywhere", "assistant", { at: 3_005 });
    const forkEntries: TimelineEntry[] = [
      messageEntry("original-request", "user", { at: 0 }),
      failure,
      messageEntry("original-reply", "assistant", { at: 5 }),
      { ...prompt, message: { ...prompt.message, text: "Fork to VPS", runId: forkRunId } },
      {
        ...comment,
        message: {
          ...comment.message,
          runId: forkRunId,
          text: 'That should be part of "launch anywhere". Checking whether the branches already have it:',
        },
      },
    ];
    const command = (id: string, second: number): TimelineEntry => {
      const item: OrchestrationV2TurnItem = {
        ...base(id, second),
        runId: forkRunId,
        type: "dynamic_tool",
        status: "running",
        toolName: "mcp__cogenly__terminal_run",
        input: { command: "git branch --show-current" },
      };
      const createdAt = DateTime.formatIso(at(second));
      return {
        id,
        kind: "work",
        createdAt,
        entry: {
          id,
          createdAt,
          runId: forkRunId,
          itemType: "dynamic_tool",
          tone: "tool",
          label: "Running terminal command",
          toolLifecycleStatus: "inProgress",
          projectedItem: projected(item),
          structuredPayload: item,
        },
      };
    };

    // The completion is still claimed, and its notification may be outside a
    // paged snapshot. Neither permits it to follow this much later live turn.
    const footer = pendingSubagentCompletions({
      threadId: "thread-parent",
      subagents: [
        {
          id: "node-integrations-revamp",
          threadId: "thread-parent",
          origin: "app_owned",
          childThreadId: "thread-integrations-revamp",
          status: "failed",
          startedAtMs: DateTime.toEpochMillis(at(1)),
          completedAtMs: DateTime.toEpochMillis(at(30)),
          completionDelivery: { state: "claimed" },
        },
      ],
      notifiedAtMsByChild: new Map(),
      notifiedAtMsByTask: new Map(),
      backgroundChildren: new Set(),
      latestParentRunAtMs: Date.parse(prompt.createdAt),
    });
    expect(footer).toEqual([]);

    const firstCommand = command("check-launch-anywhere", 3_006);
    for (const liveCommands of [[firstCommand], [firstCommand, command("check-vps-fork", 3_010)]]) {
      const rows = deriveMessagesTimelineRows({
        timelineEntries: [...forkEntries, ...liveCommands],
        latestRun: { ...runningRun, runId: forkRunId, startedAt: prompt.createdAt },
        runningRunId: forkRunId,
        isWorking: true,
        activeTurnStartedAt: prompt.createdAt,
        expandedRunIds: new Set([runId]),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      const failedRows = rows.filter(
        (row) => row.kind === "event" && row.projectedItem.item.id === failure.id,
      );
      expect(failedRows).toHaveLength(1);
      expect(rows.indexOf(failedRows[0]!)).toBeLessThan(
        rows.findIndex((row) => row.id === prompt.id),
      );
      expect(rows.at(-1)).toMatchObject({
        kind: "work-live",
        active: true,
        entry: { id: liveCommands.at(-1)!.id, runId: forkRunId },
      });
    }
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

describe("collapseRestartMarkers", () => {
  const noticeRow = (
    id: string,
    at: number,
    item: Record<string, unknown>,
  ): MessagesTimelineRow => {
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, at)).toISOString();
    return {
      kind: "work",
      id,
      createdAt,
      isExpandedToolGroup: false,
      groupedEntries: [
        {
          id,
          createdAt,
          label: String(item.summary ?? item.message ?? id),
          tone: "info",
          itemType: item.type as OrchestrationV2TurnItem["type"],
          structuredPayload: item as unknown as OrchestrationV2TurnItem,
        },
      ],
    };
  };
  const restart = (id: string, at: number, summary = "Cogenly restarted and resumed this turn") =>
    noticeRow(id, at, {
      type: "notification",
      source: { kind: "system" },
      outcome: "updated",
      summary,
    });
  const systemNotice = (id: string, at: number) =>
    noticeRow(id, at, { type: "system_notice", message: "Model switched" });
  const shape = (rows: MessagesTimelineRow[]) =>
    rows.map((row) =>
      row.kind === "restart-divider"
        ? `restart:${row.id}×${row.restarts.length}`
        : `${row.kind}:${row.id}`,
    );

  it("folds adjacent restarts into one divider that keeps every restart", () => {
    const rows = collapseRestartMarkers([restart("r1", 1), restart("r2", 2), restart("r3", 3)]);
    expect(shape(rows)).toEqual(["restart:r1×3"]);
    const [divider] = rows;
    expect(divider?.kind === "restart-divider" && divider.restarts.map((r) => r.at)).toEqual([
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:02.000Z",
      "2026-01-01T00:00:03.000Z",
    ]);
  });

  it("folds restarts separated only by other system notices", () => {
    const rows = collapseRestartMarkers([
      restart("r1", 1),
      systemNotice("s1", 2),
      restart("r2", 3, "Cogenly restarted and stopped background work"),
    ]);
    expect(shape(rows)).toEqual(["restart:r1×2", "work:s1"]);
  });

  it("keeps restarts apart once real conversation sits between them", () => {
    const message = messageEntry("a1", "assistant", { at: 2 });
    if (message.kind !== "message") throw new Error("expected a message entry");
    const rows = collapseRestartMarkers([
      restart("r1", 1),
      {
        kind: "message",
        id: "a1",
        createdAt: message.createdAt,
        message: message.message,
        durationStart: message.createdAt,
        showAssistantMeta: false,
        showAssistantCopyButton: false,
        assistantCopyStreaming: false,
      },
      restart("r2", 3),
    ]);
    expect(shape(rows)).toEqual(["restart:r1×1", "message:a1", "restart:r2×1"]);
  });

  it("leaves other system notifications as they are", () => {
    const other = noticeRow("n1", 1, {
      type: "notification",
      source: { kind: "system" },
      outcome: "updated",
      summary: "Background task finished",
    });
    expect(shape(collapseRestartMarkers([other]))).toEqual(["work:n1"]);
  });
});

describe("a cut-off fragment never replaces the turn's answer", () => {
  const assistant = (
    id: string,
    second: number,
    text: string,
    status: "completed" | "interrupted",
  ): TimelineEntry => {
    const at = DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 0, 0, second));
    const createdAt = DateTime.formatIso(at);
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make(id),
      threadId: ThreadId.make("thread-1"),
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: second,
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "assistant_message",
      status,
      messageId: MessageId.make(id),
      text,
      streaming: false,
    };
    return {
      id,
      kind: "message",
      createdAt,
      message: {
        id: MessageId.make(id),
        role: "assistant",
        text,
        runId,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      },
      projectedItem: {
        position: second,
        visibility: "local",
        sourceThreadId: item.threadId,
        sourceItemId: item.id,
        item,
      },
    };
  };
  const tool: TimelineEntry = {
    id: "tool-1",
    kind: "work",
    createdAt: "2026-01-01T00:00:02.000Z",
    entry: {
      id: "tool-1",
      createdAt: "2026-01-01T00:00:02.000Z",
      label: "Deleted a Slack message",
      tone: "tool",
      itemType: "dynamic_tool",
      runId,
      toolLifecycleStatus: "completed",
    },
  };
  const entries = [
    messageEntry("user-1", "user", { at: 0 }),
    assistant("commentary", 1, "I'll remove the two updates.", "completed"),
    tool,
    assistant("answer", 3, "Deleted both Slack updates.", "completed"),
    assistant("fragment", 4, "I'll combine the booking", "interrupted"),
  ];
  const visible = (rows: MessagesTimelineRow[]) =>
    rows.map((row) =>
      row.kind === "message" ? `${row.id}${row.showAssistantMeta ? "+meta" : ""}` : row.kind,
    );

  it("picks the last whole message as the answer", () => {
    expect([...deriveTerminalAssistantMessageIds(entries, new Set())]).toEqual(["answer"]);
  });

  it("shows the answer below the fold and folds the fragment away with the work", () => {
    expect(visible(rowsFor(entries, false))).toEqual(["user-1", "turn-fold", "answer+meta"]);
  });

  it("keeps the last words of a turn the user stopped, partial or not", () => {
    expect([...deriveTerminalAssistantMessageIds(entries, new Set([runId]))]).toEqual(["fragment"]);
  });

  it("falls back to the fragment when the turn has no whole message", () => {
    expect([
      ...deriveTerminalAssistantMessageIds(
        [entries[0]!, assistant("fragment", 1, "I'll combine", "interrupted")],
        new Set(),
      ),
    ]).toEqual(["fragment"]);
  });
});

describe("rows a disclosure reveals grow in only right after the user opens it", () => {
  const windowMs = 400;

  it("grows in rows that mount within the window, for every row that reads it", () => {
    const opens: DisclosureOpenTimes = new Map();
    markDisclosureOpened(opens, "turn-fold:a", 1_000);
    expect(disclosureOpenedRecently(opens, "turn-fold:a", 1_000, windowMs)).toBe(true);
    // A second row, or a render React discarded and redid, still sees the open.
    expect(disclosureOpenedRecently(opens, "turn-fold:a", 1_200, windowMs)).toBe(true);
  });

  it("shows later mounts at rest, so scrolling back to an open fold does not replay it", () => {
    const opens: DisclosureOpenTimes = new Map();
    markDisclosureOpened(opens, "work-group:a", 1_000);
    expect(disclosureOpenedRecently(opens, "work-group:a", 1_401, windowMs)).toBe(false);
    expect(opens.has("work-group:a")).toBe(false);
  });

  it("never grows in history nobody opened", () => {
    expect(disclosureOpenedRecently(new Map(), "turn-fold:a", 0, windowMs)).toBe(false);
  });

  it("a reopen restarts the window instead of expiring with the earlier open", () => {
    const opens: DisclosureOpenTimes = new Map();
    markDisclosureOpened(opens, "turn-fold:a", 1_000);
    markDisclosureClosed(opens, "turn-fold:a");
    expect(disclosureOpenedRecently(opens, "turn-fold:a", 1_100, windowMs)).toBe(false);
    markDisclosureOpened(opens, "turn-fold:a", 1_300);
    expect(disclosureOpenedRecently(opens, "turn-fold:a", 1_500, windowMs)).toBe(true);
  });
});

describe("a user message counts as just sent only when it arrives fresh while the thread is open", () => {
  const now = Date.UTC(2026, 0, 1, 0, 1, 0);
  const userRow = (id: string, ageMs: number) => ({
    kind: "message",
    message: { id, role: "user", createdAt: new Date(now - ageMs).toISOString() },
  });

  it("does not count history when the thread first loads", () => {
    const arrivals = createUserMessageArrivals();
    expect(recordUserMessageArrivals(arrivals, [userRow("old", 60_000)], now)).toBe(false);
  });

  it("counts the send that opened the thread, if it is that fresh", () => {
    const arrivals = createUserMessageArrivals();
    expect(recordUserMessageArrivals(arrivals, [userRow("first", 500)], now)).toBe(true);
  });

  it("counts a send or steer that shows up after the first load", () => {
    const arrivals = createUserMessageArrivals();
    recordUserMessageArrivals(arrivals, [userRow("old", 60_000)], now);
    expect(
      recordUserMessageArrivals(arrivals, [userRow("old", 60_000), userRow("steer", 5_000)], now),
    ).toBe(true);
  });

  it("does not count the persisted copy replacing an optimistic bubble again", () => {
    const arrivals = createUserMessageArrivals();
    recordUserMessageArrivals(arrivals, [userRow("old", 60_000)], now);
    recordUserMessageArrivals(arrivals, [userRow("old", 60_000), userRow("sent", 100)], now);
    // Same message id, new row object: the server confirmed the send.
    expect(
      recordUserMessageArrivals(arrivals, [userRow("old", 60_000), userRow("sent", 100)], now),
    ).toBe(false);
  });

  it("ignores assistant messages", () => {
    const arrivals = createUserMessageArrivals();
    recordUserMessageArrivals(arrivals, [userRow("old", 60_000)], now);
    expect(
      recordUserMessageArrivals(
        arrivals,
        [
          {
            kind: "message",
            message: { id: "reply", role: "assistant", createdAt: new Date(now).toISOString() },
          },
        ],
        now,
      ),
    ).toBe(false);
  });
});

describe("a disclosure toggle keeps the end pinned wherever the list would re-pin it", () => {
  const follow = { active: true, threshold: 1 };
  const at = (distanceFromEnd: number) => ({
    contentLength: 3_000,
    scroll: 3_000 - 800 - distanceFromEnd,
    scrollLength: 800,
  });

  it("pins at the end, with or without follow", () => {
    expect(resolveDisclosureHoldsEnd(at(0), follow)).toBe(true);
    expect(resolveDisclosureHoldsEnd(at(20), { ...follow, active: false })).toBe(true);
  });

  it("pins inside the follow band while streamed rows have not been pinned yet", () => {
    expect(resolveDisclosureHoldsEnd(at(300), follow)).toBe(true);
    expect(resolveDisclosureHoldsEnd(at(800), follow)).toBe(true);
  });

  it("holds the toggled row when reading history or beyond the band", () => {
    expect(resolveDisclosureHoldsEnd(at(300), { ...follow, active: false })).toBe(false);
    expect(resolveDisclosureHoldsEnd(at(801), follow)).toBe(false);
  });

  it("holds the toggled row before the list has measured", () => {
    expect(resolveDisclosureHoldsEnd(undefined, follow)).toBe(false);
    expect(resolveDisclosureHoldsEnd({ isAtEnd: false }, follow)).toBe(false);
  });
});

it("keeps the sandbox label on a collapsed Claude terminal group", () => {
  const createdAt = "2026-01-01T00:00:01.000Z";
  const entries: TimelineEntry[] = [messageEntry("sandbox-user", "user", { at: 0 })];
  for (const id of ["sandbox-1", "sandbox-2"]) {
    entries.push({
      id,
      kind: "work",
      createdAt,
      entry: {
        id,
        createdAt,
        label: "Ran command",
        tone: "tool",
        itemType: "dynamic_tool",
        runId,
        toolLifecycleStatus: "completed",
        structuredPayload: {
          id: TurnItemId.make(id),
          type: "dynamic_tool",
          status: "completed",
          toolName: "mcp__cogenly__terminal_run",
          input: { command: "pwd" },
          output: { sandbox: "read-only" },
        } as OrchestrationV2TurnItem,
      },
    });
  }
  entries.push(messageEntry("sandbox-reply", "assistant", { at: 3 }));
  const rows = deriveMessagesTimelineRows({
    timelineEntries: entries,
    latestRun: completedRun,
    expandedRunIds: new Set([runId]),
    isWorking: false,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  });
  expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
    sandboxed: true,
    expanded: false,
  });
});

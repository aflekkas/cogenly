import { MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { deriveMessagesTimelineRows, type TimelineLatestRun } from "./MessagesTimeline.logic";

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

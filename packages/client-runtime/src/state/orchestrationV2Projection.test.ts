import { describe, expect, it } from "vite-plus/test";
import {
  type ThreadPullRequestLink,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  MessageId,
  ContextHandoffId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";

import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { resolvePendingHandoff } from "../handoff.ts";

const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const threadId = ThreadId.make("thread-reducer");
const runId = RunId.make("run-reducer");
const run = {
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  providerThreadId: null,
  userMessageId: MessageId.make("message-reducer"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
} satisfies OrchestrationV2Run;

function commandItem(id: string, output = "done", ordinal = 1): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "command_execution",
    input: "pwd",
    output,
    exitCode: 0,
  };
}
const emptyProjection = {
  thread: {
    id: threadId,
    projectId: ProjectId.make("project-reducer"),
    title: "Reducer",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visualStates: [],
  visibleTurnItems: [],
  updatedAt: now,
} as OrchestrationV2ThreadProjection;

describe("applyOrchestrationV2ProjectionEvent", () => {
  it.each(["completed", "failed", "interrupted", "cancelled"] as const)(
    "clears the handoff preview after a rate-limit continuation that %s",
    (status) => {
      const personal = {
        instanceId: ProviderInstanceId.make("claude-personal"),
        model: "claude-opus-5-5",
      };
      const replacement = { ...personal, instanceId: ProviderInstanceId.make("claudeAgent") };
      const oldThreadId = ProviderThreadId.make("provider-thread:limited");
      const newThreadId = ProviderThreadId.make("provider-thread:continuation");
      const failedRun = {
        ...run,
        providerInstanceId: personal.instanceId,
        modelSelection: personal,
        providerThreadId: oldThreadId,
        status: "failed" as const,
      };
      const continuation = {
        ...run,
        id: RunId.make("run:continuation"),
        ordinal: 2,
        providerInstanceId: replacement.instanceId,
        modelSelection: replacement,
        providerThreadId: newThreadId,
        status: "starting" as const,
        startedAt: null,
        completedAt: null,
      };
      const providerThread = {
        id: newThreadId,
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: replacement.instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 2,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      } satisfies OrchestrationV2ProviderThread;
      const providers = [personal, replacement].map(({ instanceId }) => ({
        instanceId,
        driver: providerThread.driver,
      }));
      let projection: OrchestrationV2ThreadProjection = {
        ...emptyProjection,
        thread: { ...emptyProjection.thread, activeProviderThreadId: oldThreadId },
        runs: [failedRun],
        turnItems: [commandItem("existing-history")],
        visibleTurnItems: [
          {
            position: 0,
            visibility: "local",
            sourceThreadId: threadId,
            sourceItemId: TurnItemId.make("existing-history"),
            item: commandItem("existing-history"),
          },
        ],
      };
      const apply = (event: OrchestrationV2DomainEvent) => {
        projection = applyOrchestrationV2ProjectionEvent(projection, event)!;
      };
      expect(resolvePendingHandoff(projection, replacement, providers)).not.toBeNull();
      // Model selection is emitted before provider-thread activation, so its
      // thread payload still points at the limited account's provider thread.
      apply({
        id: EventId.make("selection"),
        type: "thread.provider-switched",
        threadId,
        occurredAt: now,
        payload: {
          ...projection.thread,
          providerInstanceId: replacement.instanceId,
          modelSelection: replacement,
        },
      });
      apply({
        id: EventId.make("activation"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: providerThread,
      });
      apply({
        id: EventId.make("continuation-run"),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: continuation,
      });
      apply({
        id: EventId.make("handoff"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...commandItem("completed-handoff", "", 2),
          type: "handoff",
          runId: continuation.id,
          providerThreadId: newThreadId,
          contextHandoffId: ContextHandoffId.make("handoff:continuation"),
          fromProviderThreadIds: [oldThreadId],
          toProviderThreadId: newThreadId,
          fromProviderInstanceIds: [personal.instanceId],
          toProviderInstanceId: replacement.instanceId,
          strategy: "full_thread_summary",
          summary: "Continue where you left off.",
        },
      });
      expect(resolvePendingHandoff(projection, replacement, providers)).toBeNull();
      apply({
        id: EventId.make("terminal"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...continuation, status, startedAt: now, completedAt: now },
      });
      expect(resolvePendingHandoff(projection, replacement, providers)).toBeNull();
      expect(resolvePendingHandoff(projection, personal, providers)).toEqual({
        from: [replacement],
        to: personal,
      });
      // Reserving a future provider or updating a child provider thread must
      // leave the conversation on the account that received the handoff.
      for (const payload of [
        { ...providerThread, id: oldThreadId, firstRunOrdinal: null, lastRunOrdinal: null },
        { ...providerThread, id: oldThreadId, appThreadId: ThreadId.make("child-thread") },
      ]) {
        apply({
          id: EventId.make(`unrelated-provider:${payload.appThreadId}`),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload,
        });
        expect(resolvePendingHandoff(projection, replacement, providers)).toBeNull();
      }
    },
  );

  it("applies a compact PR sync without replacing other links or thread metadata", () => {
    const link = (number: number): ThreadPullRequestLink => ({
      host: "github.com",
      repository: "pingdotgg/t3code",
      number,
      url: `https://github.com/pingdotgg/t3code/pull/${number}`,
      source: "manual",
      linkedAt: DateTime.formatIso(now),
      snapshot: null,
      stack: null,
    });
    const links = [link(1), link(2)];
    const projection = {
      ...emptyProjection,
      thread: { ...emptyProjection.thread, pullRequests: links },
    };
    const updated = { ...links[1]!, source: "agent" as const };
    const next = applyOrchestrationV2ProjectionEvent(projection, {
      id: "compact-sync" as OrchestrationV2DomainEvent["id"],
      type: "thread.pull-request-link-updated",
      threadId,
      occurredAt: now,
      payload: updated,
    });
    expect(next?.thread).toEqual({ ...projection.thread, pullRequests: [links[0], updated] });
    expect(next?.thread.pullRequests?.[0]).toBe(links[0]);
  });

  it("keeps live token usage when the terminal provider turn omits it", () => {
    const providerTurnId = ProviderTurnId.make("provider-turn-reducer");
    const running = {
      id: providerTurnId,
      providerThreadId: ProviderThreadId.make("provider-thread-reducer"),
      nodeId: NodeId.make("provider-node-reducer"),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running" as const,
      startedAt: now,
      completedAt: null,
      tokenUsage: {
        usedTokens: 50_000,
        maxTokens: 200_000,
        updatedAt: "2026-08-29T00:00:00.000Z",
      },
    };
    const projection = { ...emptyProjection, providerTurns: [running] };
    const event = {
      id: "event-provider-turn-terminal",
      type: "provider-turn.updated",
      threadId,
      driver: "codex",
      occurredAt: now,
      payload: {
        ...running,
        status: "completed",
        completedAt: now,
        tokenUsage: undefined,
      },
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);

    expect(next?.providerTurns[0]?.status).toBe("completed");
    expect(next?.providerTurns[0]?.tokenUsage).toEqual(running.tokenUsage);
  });

  it("applies thread lifecycle payloads instead of leaving stale metadata", () => {
    const archivedAt = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
    const event = {
      id: "event-archive",
      type: "thread.archived",
      threadId,
      occurredAt: archivedAt,
      payload: { ...emptyProjection.thread, archivedAt, updatedAt: archivedAt },
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(emptyProjection, event);
    expect(next?.thread.archivedAt).toEqual(archivedAt);
    expect(next?.updatedAt).toEqual(archivedAt);
  });

  it("ignores events for another thread", () => {
    const event = {
      id: "event-other",
      type: "thread.deleted",
      threadId: ThreadId.make("thread-other"),
      occurredAt: now,
      payload: { ...emptyProjection.thread, id: ThreadId.make("thread-other"), deletedAt: now },
    } as OrchestrationV2DomainEvent;

    expect(applyOrchestrationV2ProjectionEvent(emptyProjection, event)).toBe(emptyProjection);
  });

  it("preserves visible row identity when run updates do not change membership", () => {
    const item = commandItem("item-stable");
    const visibleTurnItems = [
      {
        position: 0,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      },
    ];
    const projection = {
      ...emptyProjection,
      runs: [run],
      turnItems: [item],
      visibleTurnItems,
    };
    const event = {
      id: "event-run-update",
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: { ...run, status: "completed" },
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);
    expect(next?.visibleTurnItems).toBe(visibleTurnItems);
    expect(next?.visibleTurnItems[0]).toBe(visibleTurnItems[0]);
  });

  it("replaces only the updated visible item when membership is unchanged", () => {
    const first = commandItem("item-first", "first");
    const second = commandItem("item-second", "second");
    const firstRow = {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: first.id,
      item: first,
    };
    const secondRow = {
      position: 1,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: second.id,
      item: second,
    };
    const updated = commandItem("item-first", "streamed output");
    const projection = {
      ...emptyProjection,
      runs: [run],
      turnItems: [first, second],
      visibleTurnItems: [firstRow, secondRow],
    };
    const event = {
      id: "event-item-update",
      type: "turn-item.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: updated,
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);
    expect(next?.visibleTurnItems).not.toBe(projection.visibleTurnItems);
    expect(next?.visibleTurnItems[0]).not.toBe(firstRow);
    expect(next?.visibleTurnItems[0]?.item).toBe(updated);
    expect(next?.visibleTurnItems[1]).toBe(secondRow);
  });

  it("inserts live turn items by authoritative ordinal", () => {
    const queuedFuture = commandItem("item-queued-future", "queued", 300);
    const activeAssistant = commandItem("item-active-assistant", "done", 201);
    const queuedRow = {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: queuedFuture.id,
      item: queuedFuture,
    };
    const projection = {
      ...emptyProjection,
      runs: [run],
      turnItems: [queuedFuture],
      visibleTurnItems: [queuedRow],
    };
    const event = {
      id: "event-active-assistant",
      type: "turn-item.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: activeAssistant,
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);
    expect(next?.visibleTurnItems.map((row) => row.item.id)).toEqual([
      activeAssistant.id,
      queuedFuture.id,
    ]);
    expect(next?.visibleTurnItems.map((row) => row.position)).toEqual([0, 1]);
  });

  describe("partial timeline", () => {
    const queuedRunId = RunId.make("run-queued");
    const steerRunId = RunId.make("run-steer");
    const queuedRun = { ...run, id: queuedRunId, ordinal: 2, status: "queued" } as const;
    const steerRun = { ...run, id: steerRunId, ordinal: 3, status: "completed" } as const;
    const runItem = (id: string, itemRunId: RunId, ordinal: number) => ({
      ...commandItem(id, id, ordinal),
      runId: itemRunId,
    });
    const windowOf = (
      runs: ReadonlyArray<OrchestrationV2Run>,
      items: ReadonlyArray<OrchestrationV2TurnItem>,
    ): OrchestrationV2ThreadProjection => ({
      ...emptyProjection,
      runs,
      turnItems: items,
      visibleTurnItems: items.map((item, position) => ({
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      })),
    });
    const itemEvent = (payload: OrchestrationV2TurnItem) =>
      ({
        id: `event-${payload.id}`,
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload,
      }) as OrchestrationV2DomainEvent;
    const runEvent = (payload: OrchestrationV2Run) =>
      ({
        id: `event-${payload.id}-${payload.status}`,
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload,
      }) as OrchestrationV2DomainEvent;

    it("shows a queued run that starts after a newer steer raised the watermark", () => {
      // Run 2 was queued first, run 3 was steered in and ran first. Its items
      // sit in run 3's band and already raised the watermark past run 2's band.
      const steerItems = [
        runItem("item-steer-user", steerRunId, 3_000_001),
        runItem("item-steer-reply", steerRunId, 3_000_002),
      ];
      let projection: OrchestrationV2ThreadProjection | null = windowOf(
        [run, queuedRun, steerRun],
        steerItems,
      );
      let latestLocalTurnOrdinal = 3_000_002;
      // Same order the orchestrator commits a queued start: the user message
      // lands while the run is still queued, then the run starts and replies.
      const queuedUser = runItem("item-queued-user", queuedRunId, 2_000_001);
      const queuedReply = runItem("item-queued-reply", queuedRunId, 2_000_002);
      for (const event of [
        itemEvent(queuedUser),
        runEvent({ ...queuedRun, status: "running" }),
        itemEvent(queuedReply),
        runEvent({ ...queuedRun, status: "completed" }),
      ]) {
        projection = applyOrchestrationV2ProjectionEvent(projection, event, {
          partialTimeline: true,
          latestLocalTurnOrdinal,
        });
        if (event.type === "turn-item.updated") {
          latestLocalTurnOrdinal = Math.max(latestLocalTurnOrdinal, event.payload.ordinal);
        }
      }

      expect(projection?.visibleTurnItems.map((row) => row.item.id)).toEqual([
        queuedUser.id,
        queuedReply.id,
        ...steerItems.map((item) => item.id),
      ]);
      expect(projection?.turnItems.map((item) => item.id)).toContain(queuedReply.id);
    });

    it("keeps a running run's item when the window starts after its earlier items", () => {
      // The bounded window begins inside run 3; run 2 started and kept going,
      // but none of its rows made it into the window.
      const runningRun = { ...queuedRun, status: "running" } as const;
      const steerItems = [
        runItem("item-steer-user", steerRunId, 3_000_001),
        runItem("item-steer-reply", steerRunId, 3_000_002),
      ];
      const projection = windowOf([run, runningRun, steerRun], steerItems);
      const reply = runItem("item-running-reply", queuedRunId, 2_000_003);

      const next = applyOrchestrationV2ProjectionEvent(projection, itemEvent(reply), {
        partialTimeline: true,
        latestLocalTurnOrdinal: 3_000_002,
      });

      expect(next?.visibleTurnItems.map((row) => row.item.id)).toEqual([
        reply.id,
        ...steerItems.map((item) => item.id),
      ]);
    });

    it.each([
      { name: "keeps an item of a run already in the window", itemRunId: steerRunId, kept: true },
      { name: "drops an item of a finished run outside the window", itemRunId: runId, kept: false },
    ])("$name that arrives below the watermark", ({ itemRunId, kept }) => {
      const first = runItem("item-first", steerRunId, 3_000_001);
      const later = runItem("item-later", steerRunId, 3_000_003);
      const late = runItem("item-late", itemRunId, 3_000_002);
      const projection = windowOf([run, steerRun], [first, later]);

      const next = applyOrchestrationV2ProjectionEvent(projection, itemEvent(late), {
        partialTimeline: true,
        latestLocalTurnOrdinal: later.ordinal,
      });
      if (kept) {
        expect(next?.visibleTurnItems.map((row) => row.item.id)).toEqual([
          first.id,
          late.id,
          later.id,
        ]);
      } else {
        expect(next).toBe(projection);
      }
    });
  });

  it("removes only hidden local items while preserving inherited rows", () => {
    const inherited = commandItem("item-inherited");
    const local = commandItem("item-local");
    const inheritedRow = {
      position: 0,
      visibility: "inherited" as const,
      sourceThreadId: ThreadId.make("thread-source"),
      sourceItemId: inherited.id,
      item: inherited,
    };
    const localRow = {
      position: 1,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: local.id,
      item: local,
    };
    const projection = {
      ...emptyProjection,
      runs: [run],
      turnItems: [local],
      visibleTurnItems: [inheritedRow, localRow],
    };
    const event = {
      id: "event-run-rollback",
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: { ...run, status: "rolled_back" },
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);
    expect(next?.visibleTurnItems).toEqual([inheritedRow]);
    expect(next?.visibleTurnItems[0]).toBe(inheritedRow);
  });
});

it("does not scan every row against every run for a streaming item update", () => {
  let runReads = 0;
  const runs = Array.from({ length: 100 }, (_, index) => ({
    ...run,
    get id() {
      runReads++;
      return RunId.make(`run-${index}`);
    },
  }));
  const items = Array.from({ length: 1000 }, (_, index) =>
    commandItem(`item-${index}`, "before", index),
  );
  const projection = {
    ...emptyProjection,
    runs,
    turnItems: items,
    visibleTurnItems: items.map((item, position) => ({
      item,
      position,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: item.id,
    })),
  };
  const payload = commandItem("item-999", "after", 999);
  const next = applyOrchestrationV2ProjectionEvent(projection, {
    id: "stream-update",
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload,
  } as OrchestrationV2DomainEvent);
  expect(next?.visibleTurnItems.at(-1)?.item).toBe(payload);
  expect(next?.visibleTurnItems[0]).toBe(projection.visibleTurnItems[0]);
  expect(runReads).toBeLessThanOrEqual(100);
});

it("keeps historical recovery updates for a different app thread out of the client projection", () => {
  const other = ThreadId.make("thread:related-recovery");
  const command = `command:runtime-reconcile:shutdown:${threadId}:2026-10-22T18:38:21.451Z`;
  const event: OrchestrationV2DomainEvent = {
    id: EventId.make(
      `event:thread:${encodeURIComponent(threadId)}:command:${encodeURIComponent(command)}:old`,
    ),
    type: "provider-thread.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: ProviderThreadId.make("provider-thread:related-recovery"),
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerSessionId: null,
      appThreadId: other,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    },
  };
  expect(applyOrchestrationV2ProjectionEvent(emptyProjection, event)).toBe(emptyProjection);
});

it.each(["codex", "codex-work"])(
  "replays old %s import identities over a current snapshot without adding an alias",
  (instance) => {
    const id = ThreadId.make(`import:${instance}:client-native`);
    const canonical = ProviderThreadId.make(`provider-thread:import:${instance}:client-native`);
    const providerThread: OrchestrationV2ProviderThread = {
      id: canonical,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerSessionId: null,
      appThreadId: id,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };
    const projection = {
      ...emptyProjection,
      thread: { ...emptyProjection.thread, id, activeProviderThreadId: canonical },
      providerThreads: [providerThread],
    };
    const next = applyOrchestrationV2ProjectionEvent(projection, {
      id: EventId.make("event:client-import-replay"),
      type: "provider-thread.updated",
      threadId: id,
      occurredAt: now,
      payload: {
        ...providerThread,
        id: ProviderThreadId.make("provider-thread:provider:codex:native-thread:client-native"),
        status: "idle",
      },
    });
    expect(next?.providerThreads).toEqual([{ ...providerThread, status: "idle" }]);
    expect(next?.thread.activeProviderThreadId).toBe(canonical);
  },
);

it("restores deduped bodies from the records it already holds, also in a partial timeline", () => {
  const messageId = MessageId.make("message-deduped");
  const subagentId = NodeId.make("node-deduped");
  const reply = {
    ...commandItem("item-reply", "", 400),
    type: "assistant_message",
    messageId,
    text: "the full reply",
    streaming: false,
  } as unknown as OrchestrationV2TurnItem;
  const subagent = {
    id: subagentId,
    threadId,
    runId,
    parentNodeId: NodeId.make("node-root"),
    origin: "app_owned",
    createdBy: "agent",
    driver: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: "the task brief",
    title: null,
    model: null,
    status: "running",
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  } as OrchestrationV2ThreadProjection["subagents"][number];
  const projection = {
    ...emptyProjection,
    runs: [run],
    messages: [
      {
        id: messageId,
        threadId,
        runId,
        nodeId: null,
        role: "assistant",
        text: "the full reply",
        attachments: [],
        streaming: false,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: now,
        updatedAt: now,
      },
    ],
    subagents: [subagent],
  } as OrchestrationV2ThreadProjection;
  const event = (type: string, payload: unknown) =>
    ({
      id: `event-${type}`,
      type,
      threadId,
      runId,
      occurredAt: now,
      payload,
    }) as OrchestrationV2DomainEvent;

  for (const options of [undefined, { partialTimeline: true, latestLocalTurnOrdinal: 300 }]) {
    const withReply = applyOrchestrationV2ProjectionEvent(
      projection,
      event("turn-item.updated", { ...reply, text: "", textOmitted: true }),
      options,
    );
    expect(withReply?.turnItems).toEqual([reply]);
    expect(withReply?.visibleTurnItems.map((row) => row.item)).toEqual([reply]);
  }
  const progressed = applyOrchestrationV2ProjectionEvent(
    projection,
    event("subagent.updated", { ...subagent, prompt: "", promptOmitted: true, progress: "step 2" }),
  );
  expect(progressed?.subagents).toEqual([{ ...subagent, progress: "step 2" }]);
});

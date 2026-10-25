import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationV2Run,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  WorkTaskId,
  type WorkTask,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../persistence/Sqlite.ts";
import { layerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeControllableProvider } from "../orchestration-v2/testkit/ControllableProvider.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Events from "../orchestration-v2/EventStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  WorkTaskReportReactor,
  layer as reactorLayer,
  workTaskReportFor,
  workTaskSettleFor,
} from "./WorkTaskReportReactor.ts";

const task: WorkTask = {
  id: WorkTaskId.make("task:one"),
  status: "started",
  requestedMode: "start",
  title: "Uninstall Nook and Ora",
  brief: "Uninstall both browsers.",
  targetProjectId: ProjectId.make("scratch"),
  threadId: ThreadId.make("work:one"),
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
};
const base = {
  chatThreadId: ThreadId.make("chat:one"),
  task,
  workThreadId: ThreadId.make("work:one"),
  reportedAt: "2026-10-22T01:00:00.000Z",
};

describe("workTaskReportFor", () => {
  it("reports a completed task with its reply, keyed so it is sent once", () => {
    const report = workTaskReportFor({
      ...base,
      run: { id: RunId.make("run:1"), status: "completed" },
      finalReply: "Removed  both\n\napps.",
    })!;
    expect(report.outcome).toMatchObject({ status: "completed", summary: "Removed both apps." });
    expect(report.wake.text).toContain("finished");
    expect(report.wake.text).toContain("cogenly-thread://v1/work:one");
    expect(report.wake.notification.outcome).toBe("completed");
    const again = workTaskReportFor({
      ...base,
      run: { id: RunId.make("run:2"), status: "failed" },
      finalReply: null,
    })!;
    expect(again.commandId).toBe(report.commandId);
    expect(again.wake.messageId).toBe(report.wake.messageId);
  });

  it("asks for a next step when the task failed, and clips the card summary", () => {
    const report = workTaskReportFor({
      ...base,
      run: { id: RunId.make("run:1"), status: "failed" },
      finalReply: "x".repeat(1000),
    })!;
    expect(report.outcome.summary.length).toBeLessThanOrEqual(280);
    expect(report.wake.text).toContain("Do not retry on your own");
  });

  it("does not report a run that is still going or was stopped by the user", () => {
    for (const status of ["running", "interrupted"] as const) {
      expect(
        workTaskReportFor({ ...base, run: { id: RunId.make("run:1"), status }, finalReply: "" }),
      ).toBeNull();
    }
  });
});

describe("workTaskSettleFor", () => {
  const settling = { ...task, settleWhenDone: true };

  it("settles the Work thread of a completed task that asked for it", () => {
    expect(
      workTaskSettleFor({ ...base, task: settling, run: { status: "completed" } }),
    ).toMatchObject({ type: "thread.settle", threadId: "work:one" });
  });

  it("leaves failed, cancelled and unasked tasks active", () => {
    for (const status of ["failed", "cancelled"] as const) {
      expect(workTaskSettleFor({ ...base, task: settling, run: { status } })).toBeNull();
    }
    expect(workTaskSettleFor({ ...base, run: { status: "completed" } })).toBeNull();
  });
});

const database = Sqlite.layerMemory;
const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
const projectionsLayer = ProjectionStore.layer.pipe(Layer.provide(database));
const integrationLayer = Layer.mergeAll(
  projectionsLayer,
  Events.layer.pipe(Layer.provide(database)),
  layerWithRegistry({ name: "work-task-settle" }, provider.registry, {
    databaseLayer: database,
    runEffectWorker: false,
  }),
);

/** Seed the terminal milestone in the real event sink; no provider process is needed. */
const reportHarness = (status: "completed" | "failed" | "cancelled", race?: "active" | "queued") =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const events = yield* Events.EventStoreV2;
    const now = yield* DateTime.now;
    const chatId = base.chatThreadId;
    const workId = base.workThreadId;
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
    for (const [threadId, surface] of [
      [chatId, "chat"],
      [workId, "work"],
    ] as const) {
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:" + threadId),
        threadId,
        projectId: task.targetProjectId!,
        title: surface,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const thread = yield* projections.getThread(threadId);
      yield* sink.write({
        events: [
          {
            id: EventId.make("metadata:" + threadId),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: ProviderInstanceId.make("codex"),
            occurredAt: now,
            payload: {
              ...thread,
              surface,
              ...(surface === "chat"
                ? { workTasks: [{ ...task, settleWhenDone: true }] }
                : { sourceThreadId: chatId }),
            },
          },
        ],
      });
    }
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start:work"),
      threadId: workId,
      messageId: MessageId.make("message:work"),
      text: "Do the task",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const work = yield* engine.getThreadProjection(workId);
    const terminalEvent: Extract<OrchestrationV2DomainEvent, { type: "run.updated" }> = {
      id: EventId.make("run:ended"),
      type: "run.updated",
      threadId: workId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      occurredAt: now,
      payload: OrchestrationV2Run.make({
        ...work.runs[0]!,
        status,
        startedAt: now,
        completedAt: now,
      }),
    };
    yield* sink.write({ events: [terminalEvent] });
    // Insert a real user turn after the reactor's idle check, before settle dispatch.
    // The queued variant models a queue held after Stop. The real orchestrator
    // must refuse both; the reactor still persists the original task's report.
    let raced = false;
    const reactorProjections = ProjectionStore.ProjectionStoreV2.of({
      ...projections,
      getThreadRecords: (threadId, fields, filter) =>
        projections.getThreadRecords(threadId, fields, filter).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              if (
                race === undefined ||
                raced ||
                threadId !== workId ||
                !fields.some((field) => field === "messages")
              )
                return;
              raced = true;
              yield* engine.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make("race:user"),
                threadId: workId,
                messageId: MessageId.make("message:followup"),
                text: "More work",
                attachments: [],
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              });
              if (race === "queued") {
                const next = (yield* engine.getThreadProjection(workId)).runs.find(
                  (run) => run.id !== terminalEvent.payload.id,
                )!;
                yield* sink.write({
                  events: [
                    {
                      ...terminalEvent,
                      id: EventId.make("run:queued"),
                      payload: { ...next, status: "queued", queueHeld: true, queuePosition: 1 },
                    },
                  ],
                });
              }
            }).pipe(Effect.orDie),
          ),
        ),
    });
    const reactor = yield* WorkTaskReportReactor.pipe(
      Effect.provide(
        reactorLayer.pipe(
          Layer.provide(Layer.succeed(ProjectionStore.ProjectionStoreV2, reactorProjections)),
        ),
      ),
    );
    const before = yield* sink.latestSequence();
    yield* reactor.handle(terminalEvent);
    const chat = yield* engine.getThreadProjection(chatId);
    const report = chat.messages.find(
      (message) => message.notification?.source.kind === "work_task",
    );
    const persisted = yield* events.read({ afterSequence: before }).pipe(Stream.runCollect);
    return {
      engine,
      reactor,
      terminalEvent,
      chat,
      report,
      persisted,
      work: yield* engine.getThreadProjection(workId),
    };
  });

describe("WorkTaskReportReactor with the real orchestrator", () => {
  it.effect("persists settling before the chat report, reports once, and supports unsettle", () =>
    Effect.gen(function* () {
      const h = yield* reportHarness("completed");
      expect(h.work.thread.settledOverride).toBe("settled");
      expect(h.chat.thread.workTasks?.[0]?.outcome?.status).toBe("completed");
      expect(h.report?.text).toContain("Its Work thread was settled");
      const settled = h.persisted.find(
        (row) => row.event.type === "thread.settled" && row.event.threadId === base.workThreadId,
      );
      const reported = h.persisted.find(
        (row) => row.event.type === "message.updated" && row.event.threadId === base.chatThreadId,
      );
      expect(settled).toBeDefined();
      expect(settled!.sequence).toBeLessThan(reported!.sequence);
      yield* h.reactor.handle(h.terminalEvent);
      const replay = yield* h.engine.getThreadProjection(base.chatThreadId);
      expect(
        replay.messages.filter((message) => message.notification?.source.kind === "work_task"),
      ).toHaveLength(1);
      yield* h.engine.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("reopen:work"),
        threadId: base.workThreadId,
        reason: "user",
      });
      const reopened = yield* h.engine.getThreadProjection(base.workThreadId);
      expect(reopened.thread.settledOverride).toBe("active");
      expect(reopened.thread.settledAt).toBeNull();
    }).pipe(Effect.provide(integrationLayer), Effect.scoped),
  );

  it.effect.each(["active", "queued"] as const)(
    "reports after settle refusal for a new %s user turn",
    (race) =>
      Effect.gen(function* () {
        const h = yield* reportHarness("completed", race);
        expect(h.work.thread.settledOverride).not.toBe("settled");
        expect(h.chat.thread.workTasks?.[0]?.outcome?.status).toBe("completed");
        expect(h.report).toBeDefined();
        expect(h.report!.text).not.toContain("Its Work thread was settled");
        expect(
          h.work.runs.some((run) =>
            race === "queued"
              ? run.status === "queued"
              : ["preparing", "starting", "running", "waiting"].includes(run.status),
          ),
        ).toBe(true);
      }).pipe(Effect.provide(integrationLayer), Effect.scoped),
  );

  it.effect.each(["failed", "cancelled"] as const)(
    "reports %s tasks while keeping Work active",
    (status) =>
      Effect.gen(function* () {
        const h = yield* reportHarness(status);
        expect(h.work.thread.settledOverride).not.toBe("settled");
        expect(h.chat.thread.workTasks?.[0]?.outcome?.status).toBe(status);
        expect(h.report).toBeDefined();
        expect(h.report!.text).not.toContain("Its Work thread was settled");
      }).pipe(Effect.provide(integrationLayer), Effect.scoped),
  );
});

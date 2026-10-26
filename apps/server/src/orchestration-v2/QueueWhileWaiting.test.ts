import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  ScheduledTaskId,
} from "@cogenly/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Receipts from "./CommandReceiptStore.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as DateTime from "effect/DateTime";
import * as EventSink from "./EventSink.ts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Worker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { makeControllableProvider } from "./testkit/ControllableProvider.ts";

it.effect.each(
  [
    { providerName: "Codex", capabilities: CodexProviderCapabilitiesV2 },
    { providerName: "Claude", capabilities: ClaudeProviderCapabilitiesV2 },
    {
      providerName: "no steering",
      capabilities: {
        ...CodexProviderCapabilitiesV2,
        turns: { ...CodexProviderCapabilitiesV2.turns, supportsActiveSteering: false },
      },
    },
  ].flatMap((scenario) => [
    { ...scenario, arrival: "before" },
    { ...scenario, arrival: "after" },
    { ...scenario, arrival: "auto" },
    { ...scenario, arrival: "scheduled" },
  ]),
)(
  "advances user/MCP follow-ups while a child and monitor work ($providerName, arrival=$arrival)",
  ({ capabilities, arrival }) => {
    const supportsSteering = capabilities.turns.supportsActiveSteering;
    const provider = makeControllableProvider(capabilities);
    const database = Sqlite.layerMemory;
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("thread:parent");
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:test"),
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send"),
        threadId,
        messageId: MessageId.make("message:parent"),
        text: "Work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      yield* orchestrator.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
        Stream.filter((row) => row.event.type === "provider-turn.updated"),
        Stream.take(1),
        Stream.runDrain,
      );
      const parent = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate"),
        parentThreadId: threadId,
        parentRunId: parent.id,
        parentNodeId: parent.rootNodeId!,
        task: "Child work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
        createdBy: "agent",
        creationSource: "server",
      });
      yield* worker.drain();
      const sink = yield* EventSink.EventSinkV2;
      const monitorBase = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
        (item) => item.type === "user_message",
      )!;
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:monitor-started"),
            type: "turn-item.updated",
            threadId,
            runId: parent.id,
            occurredAt: yield* DateTime.now,
            payload: {
              ...monitorBase,
              id: TurnItemId.make("item:monitor"),
              type: "dynamic_tool",
              status: "running",
              toolName: "Monitor",
              input: { persistent: true },
            },
          },
        ],
      });
      const followup =
        arrival === "before"
          ? orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("follow-up"),
              threadId,
              messageId: MessageId.make("message:follow-up"),
              text: "Follow up while the child works",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            })
          : Threads.ThreadManagementService.use((threads) =>
              threads.sendToThread({
                projectId: ProjectId.make("project:test"),
                commandId: CommandId.make("follow-up"),
                threadId,
                messageId: MessageId.make("message:follow-up"),
                text: "Follow up while the child works",
                attachments: [],
                mode: arrival === "auto" ? "auto" : "queue",
                createdBy: "agent",
                creationSource: "mcp",
                ...(arrival === "scheduled"
                  ? { scheduledTaskId: ScheduledTaskId.make("task:scheduled") }
                  : { senderThreadId: ThreadId.make("thread:sender") }),
              }),
            );
      if (arrival === "before") {
        yield* followup;
        expect((yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status).toBe(
          "queued",
        );
      }
      const parentInput = provider.turns.find((turn) => turn.threadId === threadId)!;
      const parentTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
      yield* provider.finish(parentInput, parentTurn.id);
      yield* orchestrator.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
        Stream.filter(
          (row) =>
            row.event.type === "run.updated" &&
            row.event.payload.id === parent.id &&
            row.event.payload.status === "waiting",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      if (arrival !== "before") yield* followup;
      const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.userMessageId === MessageId.make("message:follow-up"),
      )!;
      if (arrival !== "before") expect(queued.status).toBe("starting");
      // The queue must advance on provider settlement, before checkpoint effects
      // are drained and without waiting for the delegated task to finish.
      yield* orchestrator.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
        Stream.filter(
          (row) =>
            (row.event.type === "run.updated" || row.event.type === "run.created") &&
            row.event.payload.id === queued.id &&
            row.event.payload.status === "starting",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* worker.drain();
      yield* orchestrator.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
        Stream.filter(
          (row) =>
            row.event.type === "run.updated" &&
            row.event.payload.id === queued.id &&
            row.event.payload.status === "running",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      // Steering targets the run's running provider turn, persisted after the run itself.
      const followupAttempt = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.id === queued.id,
      )?.activeAttemptId;
      yield* orchestrator.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
        Stream.filter(
          (row) =>
            row.event.type === "provider-turn.updated" &&
            row.event.payload.runAttemptId === followupAttempt &&
            row.event.payload.status === "running",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const duringFollowup = yield* orchestrator.getThreadProjection(threadId);
      expect(duringFollowup.subagents[0]?.status).toBe("running");
      expect(provider.turns.filter((turn) => turn.threadId === threadId)).toHaveLength(2);
      if (supportsSteering) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queued-steer"),
          threadId,
          messageId: MessageId.make("message:steer"),
          text: "Steer this queued item",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const steerRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === MessageId.make("message:steer"),
        )!;
        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote"),
          threadId,
          queuedRunId: steerRun.id,
          targetRunId: queued.id,
        });
        yield* worker.drain();
        expect(provider.steers[0]?.message.text).toContain("Steer this queued item");
      }
      const childInput = provider.turns.find((turn) => turn.threadId !== threadId)!;
      const childTurn = (yield* orchestrator.getThreadProjection(childInput.threadId))
        .providerTurns[0];
      // Wait on the persisted provider turn before emitting its terminal.
      yield* orchestrator
        .streamStoredEventsFrom({ afterSequence: 0, threadId: childInput.threadId })
        .pipe(
          Stream.filter((row) => row.event.type === "provider-turn.updated"),
          Stream.take(1),
          Stream.runDrain,
        );
      const childProjection = yield* orchestrator.getThreadProjection(childInput.threadId);
      yield* provider.finish(childInput, childTurn?.id ?? childProjection.providerTurns[0]!.id);
      yield* orchestrator
        .streamStoredEventsFrom({ afterSequence: 0, threadId: childInput.threadId })
        .pipe(
          Stream.filter(
            (row) => row.event.type === "run.updated" && row.event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
      yield* worker.drain();
      yield* orchestrator.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
        Stream.filter(
          (row) =>
            row.event.type === "subagent.updated" && row.event.payload.status === "completed",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* orchestrator.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
        Stream.filter(
          (row) =>
            row.event.type === "message.updated" &&
            row.event.payload.delegatedCompletion !== undefined,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* worker.drain();
      const after = yield* orchestrator.getThreadProjection(threadId);
      expect(after.runs.filter((run) => run.status === "queued")).toHaveLength(
        supportsSteering ? 0 : 1,
      );
      expect(after.runs.find((run) => run.id === queued.id)?.status).toBe("running");
      expect(provider.steers).toHaveLength(supportsSteering ? 2 : 0);
      expect(
        after.messages.filter((message) => message.delegatedCompletion !== undefined),
      ).toHaveLength(1);
      if (supportsSteering) {
        expect(provider.steers[1]?.runId).toBe(queued.id);
        expect(provider.steers[1]?.message.text).toContain("task");
      } else {
        const followupInput = provider.turns.find((turn) => turn.runId === queued.id)!;
        const followupTurn = after.providerTurns.find(
          (turn) => turn.runAttemptId === queued.activeAttemptId,
        )!;
        yield* provider.finish(followupInput, followupTurn.id);
        const delivery = after.runs.find((run) => run.status === "queued")!;
        yield* orchestrator.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
          Stream.filter(
            (row) =>
              row.event.type === "run.updated" &&
              row.event.payload.id === delivery.id &&
              row.event.payload.status === "starting",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* worker.drain();
        expect(provider.turns.filter((turn) => turn.runId === delivery.id)).toHaveLength(1);
        expect(provider.turns.find((turn) => turn.runId === delivery.id)?.message.text).toContain(
          "task",
        );
      }
    }).pipe(
      Effect.provide(
        Threads.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              layerWithRegistry({ name: "delegated-completion-steer" }, provider.registry, {
                databaseLayer: database,
                runEffectWorker: false,
                runContinuationWorker: true,
              }),
              Receipts.layer.pipe(Layer.provide(database)),
              ServerSettings.layerTest({}),
            ),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  },
);

import { expect, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Worker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { makeControllableProvider } from "./testkit/ControllableProvider.ts";

it.effect.each([
  { interruptsTools: false, supportsSteering: true },
  { interruptsTools: true, supportsSteering: true },
  { interruptsTools: false, supportsSteering: false },
])(
  "delivers a child result (interruptsTools=$interruptsTools, supportsSteering=$supportsSteering)",
  ({ interruptsTools, supportsSteering }) => {
    const provider = makeControllableProvider({
      ...CodexProviderCapabilitiesV2,
      turns: {
        ...CodexProviderCapabilitiesV2.turns,
        activeSteeringInterruptsTools: interruptsTools,
        supportsActiveSteering: supportsSteering,
      },
    });
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
      expect(after.runs.find((run) => run.id === parent.id)?.status).toBe("running");
      expect(provider.steers).toHaveLength(supportsSteering ? 1 : 0);
      if (supportsSteering) expect(provider.steers[0]?.message.text).toContain("task");
    }).pipe(
      Effect.provide(
        layerWithRegistry({ name: "delegated-completion-steer" }, provider.registry, {
          runEffectWorker: false,
          runContinuationWorker: true,
        }),
      ),
    );
  },
);

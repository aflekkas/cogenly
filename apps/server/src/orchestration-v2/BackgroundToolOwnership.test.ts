import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Worker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { assertRunOwnership } from "../mcp/runOwnership.ts";
import { makeControllableProvider } from "./testkit/ControllableProvider.ts";

it.effect.each([
  { providerName: "Claude", capabilities: ClaudeProviderCapabilitiesV2 },
  { providerName: "Codex", capabilities: CodexProviderCapabilitiesV2 },
])("settled background work may delegate until Stop ($providerName)", ({ capabilities }) => {
  const provider = makeControllableProvider(capabilities);
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

    yield* worker.drain();
    const shell = yield* orchestrator.getThreadShell(threadId);
    expect(shell?.activeRunId).toBeNull();
    expect(shell?.pendingBackgroundTasks?.length).toBeGreaterThan(0);
    const authorize = Effect.gen(function* () {
      yield* assertRunOwnership({
        caller: (yield* orchestrator.getThreadShell(threadId))!,
        scope: {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "test",
          issuedAt: 0,
          client: undefined,
          capabilities: new Set(["orchestration"]),
          thread: {
            threadId,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: "native-parent",
          },
        },
        threads: { getThreadRecords: orchestrator.getThreadRecords },
      });
    });
    yield* authorize;
    const delegate = (key: string) =>
      orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make(key),
        parentThreadId: threadId,
        parentRunId: parent.id,
        parentNodeId: parent.rootNodeId!,
        task: "More background work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
        createdBy: "agent",
        creationSource: "server",
      });
    yield* delegate("background-delegate");
    yield* worker.drain();
    expect((yield* orchestrator.getThreadProjection(threadId)).subagents).toHaveLength(2);
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop"),
      threadId,
    });
    expect(yield* authorize.pipe(Effect.flip)).toMatchObject({ code: "parent_not_active" });
    expect((yield* delegate("late-delegate").pipe(Effect.flip))._tag).toBe(
      "OrchestratorDispatchError",
    );
    yield* worker.drain();
  }).pipe(
    Effect.provide(
      layerWithRegistry({ name: "background-tool-ownership" }, provider.registry, {
        runEffectWorker: false,
      }),
    ),
  );
});

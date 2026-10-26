import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import * as Sqlite from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { makeControllableProvider } from "../orchestration-v2/testkit/ControllableProvider.ts";
import { layerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeSweep } from "./StaleRunRecoveryWorker.ts";

it.effect("the stale sweep settles a dead run and leaves a live provider session alone", () => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2, ["codex", "codex-work"]);
  const database = Sqlite.layerMemory;
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const sessions = yield* Sessions.ProviderSessionManagerV2;
    const sql = yield* SqlClient.SqlClient;
    const dead = ThreadId.make("thread:dead");
    const live = ThreadId.make("thread:live");
    for (const [threadId, instance] of [
      [dead, "codex"],
      [live, "codex-work"],
    ] as const) {
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:recovery"),
        title: threadId,
        modelSelection: { instanceId: ProviderInstanceId.make(instance), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`send:${threadId}`),
        threadId,
        messageId: MessageId.make(`message:${threadId}`),
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
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const run = projection.runs[0]!;
      const now = yield* DateTime.now;
      const taskId = NodeId.make(`task:${threadId}`);
      yield* provider.publish({
        type: "subagent.updated",
        driver: ProviderDriverKind.make("codex"),
        subagent: {
          id: taskId,
          threadId,
          runId: run.id,
          parentNodeId: run.rootNodeId!,
          origin: "provider_native",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: run.providerInstanceId,
          providerThreadId: run.providerThreadId,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Explore",
          title: "Explore",
          model: "gpt-5",
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      });
      yield* orchestrator.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
        Stream.filter((row) => row.event.type === "subagent.updated"),
        Stream.take(1),
        Stream.runDrain,
      );
    }
    const deadProjection = yield* orchestrator.getThreadProjection(dead);
    const deadSession = deadProjection.providerThreads[0]!.providerSessionId!;
    // Model a lost process that never delivered its terminal provider event.
    const isLive = sessions.isLive;
    const liveness = vi
      .spyOn(sessions, "isLive")
      .mockImplementation((id) => (id === deadSession ? Effect.succeed(false) : isLive(id)));
    const get = vi
      .spyOn(sessions, "get")
      .mockImplementation(() => Effect.die("recovery touched runtime activity"));
    try {
      yield* sql`UPDATE orchestration_v2_projection_runs SET requested_at = '1900-01-01T00:00:00.000Z'`;
      yield* sql`UPDATE orchestration_v2_projection_subagents SET started_at = '1900-01-01T00:00:00.000Z'`;
      const sweep = yield* makeSweep.pipe(
        Effect.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: orchestrator.dispatch,
            getThreadRecords: orchestrator.getThreadRecords,
          }),
        ),
      );
      yield* sweep();
      yield* worker.drain();
      expect((yield* orchestrator.getThreadProjection(dead)).runs[0]!.status).toBe("interrupted");
      expect((yield* orchestrator.getThreadProjection(live)).runs[0]!.status).toBe("running");
      expect((yield* orchestrator.getThreadProjection(dead)).subagents[0]!.status).toBe(
        "interrupted",
      );
      expect((yield* orchestrator.getThreadProjection(live)).subagents[0]!.status).toBe("running");
      expect(get).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      liveness.mockRestore();
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        database,
        layerWithRegistry({ name: "stale-sweep" }, provider.registry, {
          databaseLayer: database,
          runEffectWorker: false,
        }),
      ),
    ),
  );
});

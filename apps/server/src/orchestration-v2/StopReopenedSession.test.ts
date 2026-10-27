import { expect, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Worker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { makeControllableProvider } from "./testkit/ControllableProvider.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

it.effect("Stop settles at once a turn that started before its session id was reopened", () => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2, ["codex"]);
  const database = Sqlite.layerMemory;
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const sql = yield* SqlClient.SqlClient;
    const start = (threadId: ThreadId) =>
      Effect.gen(function* () {
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${threadId}`),
          threadId,
          projectId: ProjectId.make("project:stop"),
          title: threadId,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
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
      });
    const stop = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`stop:${threadId}`),
          threadId,
          runId: run.id,
        });
        // Read before draining: a dead session settles the run in the dispatch
        // itself, while a live one waits for the provider's interrupt effect.
        const status = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.status;
        yield* worker.drain();
        return status;
      });

    const stale = ThreadId.make("thread:stale");
    const current = ThreadId.make("thread:current");
    yield* start(stale);
    yield* start(current);
    // The stale turn began before the live runtime under the same session id
    // opened, as after a restart. That runtime will never report its end.
    yield* sql`UPDATE orchestration_v2_projection_provider_turns
      SET started_at = '1900-01-01T00:00:00.000Z',
        payload_json = json_set(payload_json, '$.startedAt', '1900-01-01T00:00:00.000Z')
      WHERE thread_id = ${stale}`;

    expect(yield* stop(stale)).toBe("interrupted");
    // A turn the live runtime is running still waits for the provider's answer.
    expect(yield* stop(current)).not.toBe("interrupted");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        database,
        layerWithRegistry({ name: "stop-reopened-session" }, provider.registry, {
          databaseLayer: database,
          runEffectWorker: false,
        }),
      ),
    ),
  );
});

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, RunId, ThreadId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Outbox from "./EffectOutbox.ts";
import * as Worker from "./EffectWorker.ts";
import { AgentHandoffPendingError, ProviderTurnStartError } from "./ProviderTurnStartService.ts";

it.effect(
  "keeps a model switch retryable beyond the normal attempt limit while its brief generates",
  () =>
    Effect.gen(function* () {
      let ready = false;
      const runId = RunId.make("run:handoff");
      const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));
      const outboxLayer = Outbox.layer.pipe(Layer.provideMerge(database));
      const layer = Worker.layerWithOptions({ maxAttempts: 1 }).pipe(
        Layer.provide(
          Layer.mock(Worker.OrchestrationEffectExecutorV2)({
            execute: (effect) =>
              Effect.suspend(() =>
                ready
                  ? Effect.void
                  : Effect.fail(
                      new Worker.OrchestrationEffectExecutionError({
                        effectId: effect.id,
                        effectType: effect.request.type,
                        cause: new ProviderTurnStartError({
                          runId,
                          cause: new AgentHandoffPendingError({ runId }),
                        }),
                      }),
                    ),
              ),
          }),
        ),
        Layer.provideMerge(outboxLayer),
      );
      yield* Effect.gen(function* () {
        const outbox = yield* Outbox.EffectOutboxV2;
        const worker = yield* Worker.OrchestrationEffectWorkerV2;
        const sql = yield* SqlClient.SqlClient;
        yield* outbox.enqueue([
          {
            id: "waiting-brief",
            commandId: CommandId.make("command:handoff"),
            threadId: ThreadId.make("thread:handoff"),
            request: { type: "provider-turn.start", runId },
          },
        ]);
        expect(yield* worker.drain()).toBe(1);
        expect(
          yield* sql`SELECT status, attempt_count FROM orchestration_v2_effect_outbox WHERE effect_id = 'waiting-brief'`,
        ).toEqual([{ status: "pending", attempt_count: 1 }]);
        yield* TestClock.adjust("5 seconds");
        expect(yield* worker.drain()).toBe(1);
        expect(
          yield* sql`SELECT status, attempt_count FROM orchestration_v2_effect_outbox WHERE effect_id = 'waiting-brief'`,
        ).toEqual([{ status: "pending", attempt_count: 2 }]);
        ready = true;
        yield* TestClock.adjust("5 seconds");
        expect(yield* worker.drain()).toBe(1);
        expect(
          yield* sql`SELECT status FROM orchestration_v2_effect_outbox WHERE effect_id = 'waiting-brief'`,
        ).toEqual([{ status: "succeeded" }]);
      }).pipe(Effect.provide(layer));
    }),
);

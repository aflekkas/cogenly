import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Orchestrator from "./Orchestrator.ts";

/** Recover old queues and missed event ordering without waiting for another turn to end. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("queued-messages", orchestrator.resumeQueuedRuns.pipe(Effect.asVoid));
  }),
);

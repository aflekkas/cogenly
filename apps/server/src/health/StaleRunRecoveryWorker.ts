import { CommandId, NodeId, RunId } from "@cogenly/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { readStaleRuns } from "./staleRuns.ts";

/** Candidate ages only select work; dispatch rechecks session liveness under the thread lock. */
export const makeSweep = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  return Effect.fn("StaleRunRecoveryWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const candidates = yield* readStaleRuns(now);
    for (const threadId of new Set(candidates.map((run) => run.threadId))) {
      const stale = candidates.filter((run) => run.threadId === threadId);
      yield* Effect.gen(function* () {
        yield* threads.dispatch({
          type: "thread.stale-work.settle",
          commandId: CommandId.make(
            `command:stale-recovery:${threadId}:${DateTime.toEpochMillis(now)}`,
          ),
          threadId,
          runIds: stale.filter((run) => run.kind === "run").map((run) => RunId.make(run.id)),
          subagentIds: stale
            .filter((run) => run.kind === "subagent")
            .map((run) => NodeId.make(run.id)),
          keepLiveSessions: true,
          reason: "Automatically settled stale work whose provider session is no longer live.",
        });
        const after = yield* threads.getThreadRecords(threadId, ["runs", "subagents"]);
        const settled = stale.filter((candidate) => {
          const row =
            candidate.kind === "run"
              ? after.runs.find((run) => run.id === candidate.id)
              : after.subagents.find((task) => task.id === candidate.id);
          return (
            row !== undefined &&
            !["preparing", "starting", "running", "pending"].includes(row.status)
          );
        });
        if (settled.length > 0)
          yield* Effect.logInfo("Automatically settled stale work", {
            threadId,
            settled: settled.map(({ kind, id }) => ({ kind, id })),
          });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Stale work recovery failed", { threadId, cause }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    let lastSweep: number | undefined;
    yield* scheduler.register(
      "stale-run-recovery",
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (lastSweep !== undefined && now - lastSweep < 60 * 60 * 1000) return;
        yield* sweep();
        lastSweep = now;
      }),
    );
  }),
);

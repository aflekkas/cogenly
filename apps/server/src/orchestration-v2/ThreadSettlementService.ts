import { type ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import { forkParked } from "../serverActivation.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

function toMillis(value: DateTime.Utc | null | undefined): number | null {
  return value == null ? null : DateTime.toEpochMillis(value);
}

/**
 * A recent user message stays queued until a run adopts its timestamp.
 * Absolute age bounds client clock skew in both directions and stops stale
 * pre-adoption data from blocking the thread forever. A failed run start
 * clears the block immediately (mirrors the v1 session "error" rule).
 */
export function threadHasQueuedTurnStart(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "latestUserMessageAt"
    | "latestRunRequestedAt"
    | "latestRunStartedAt"
    | "latestRunCompletedAt"
    | "latestRunId"
    | "status"
  >,
  nowMs: number,
): boolean {
  const messageAtMs = toMillis(thread.latestUserMessageAt);
  if (messageAtMs === null || thread.status === "failed") return false;
  const age = nowMs - messageAtMs;
  if (Number.isNaN(age) || Math.abs(age) > QUEUED_TURN_START_GRACE_MS) return false;
  if (thread.latestRunId === null) return true;
  return [
    toMillis(thread.latestRunRequestedAt),
    toMillis(thread.latestRunStartedAt),
    toMillis(thread.latestRunCompletedAt),
  ].every((value) => value === null || value < messageAtMs);
}

/**
 * Whether a thread is parked on its snooze: its wake time is in the future and
 * it has not raised its hand with a pending request, a fresh failure, or work
 * that completed after the snooze. Server twin of the client's
 * `effectiveSnoozed`, so agents and the sidebar agree on what is snoozed. One
 * difference: a failure counts as fresh when its run completed after the
 * snooze. The client compares the shell's
 * update time, so a rename can wake a failed thread there but not here.
 */
export function isSnoozed(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "snoozedUntil" | "snoozedAt" | "latestRunCompletedAt" | "status" | "pendingRuntimeRequest"
  >,
  nowMs: number,
): boolean {
  const snoozedUntilMs = toMillis(thread.snoozedUntil);
  if (snoozedUntilMs === null || snoozedUntilMs <= nowMs) return false;
  if (thread.pendingRuntimeRequest !== null) return false;
  const snoozedAtMs = toMillis(thread.snoozedAt);
  const completedAtMs = toMillis(thread.latestRunCompletedAt);
  const wokeOnError =
    thread.status === "failed" &&
    (snoozedAtMs === null || (completedAtMs !== null && completedAtMs > snoozedAtMs));
  // Like the client, only a run that completed wakes it; an interrupt or cancel does not.
  const wokeOnCompletion =
    thread.status === "completed" &&
    snoozedAtMs !== null &&
    completedAtMs !== null &&
    completedAtMs > snoozedAtMs;
  return !wokeOnError && !wokeOnCompletion;
}

export class ThreadSettlementServiceV2 extends Context.Service<
  ThreadSettlementServiceV2,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("cogenly-server/orchestration-v2/ThreadSettlementService/ThreadSettlementServiceV2") {}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const terminals = yield* TerminalManager.TerminalManager;
  const projectScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  // Settling a settled thread re-emits thread.settled with the same settledAt,
  // so this keeps the settle action to one run per settlement.
  const settleActionRunAt = new Map<ThreadId, number>();

  // Settling closes the thread's shells that sit at an idle prompt, so they stop
  // holding the worktree. A terminal running a command (a dev server, an
  // editor) stays for the user to close. Then the project's settle script runs
  // in the thread's own worktree; a thread in the shared checkout skips it,
  // because other threads may still be working there.
  const cleanUpSettledThread = Effect.fn("ThreadSettlementServiceV2.cleanUpSettledThread")(
    function* (threadId: ThreadId) {
      // A thread re-engaged before this event ran keeps its shells.
      const settled = yield* projections.getThread(threadId);
      if (settled.settledOverride !== "settled") return;
      yield* terminals.closeIdle({ threadId });
      const worktreePath = settled.worktreePath;
      if (worktreePath === null || !(yield* fileSystem.exists(worktreePath))) return;
      // Closing and the worktree check wait on I/O. A thread re-engaged
      // meanwhile is working again, so its worktree is no place for cleanup.
      const thread = yield* projections.getThread(threadId);
      if (thread.settledOverride !== "settled") return;
      const settledAtMs = toMillis(thread.settledAt);
      if (settledAtMs === null || settleActionRunAt.get(threadId) === settledAtMs) return;
      const run = yield* projectScripts.runForThread({
        threadId,
        projectId: thread.projectId,
        worktreePath,
        trigger: "settle",
        // A clean exit closes the script's shell so it does not hold the worktree.
        observeCompletion: {},
      });
      // Recorded after a successful start, so a failed start retries on the next event.
      settleActionRunAt.set(threadId, settledAtMs);
      if (run.status === "started" && run.completion) {
        yield* run.completion.pipe(Effect.forkDetach);
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("cleaning up a settled thread failed", {
                threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
  );

  const start: ThreadSettlementServiceV2["Service"]["start"] = Effect.fn(
    "ThreadSettlementServiceV2.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "thread.settled" ? cleanUpSettledThread(event.threadId) : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Thread settlement event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start } satisfies ThreadSettlementServiceV2["Service"];
});

export const layer = Layer.effect(ThreadSettlementServiceV2, make);

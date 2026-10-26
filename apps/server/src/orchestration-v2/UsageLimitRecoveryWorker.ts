import {
  CommandId,
  limitRecoveryResumeAt,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2LimitRecoveryUpdate,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { deliverDelegatedTaskRecoveryNotice } from "./DelegatedTaskFailureNotice.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  LIMIT_ARM_COMMAND_PREFIX,
  MAX_RATE_LIMIT_RETRIES,
  nextRateLimitRetry,
} from "./UsageLimitStop.ts";

export { limitAutoResumeUpdate, limitRecoveryStatus } from "./UsageLimitStop.ts";

/**
 * The persisted run and reset form the identity of one recovery opportunity.
 * A stop the user has not chosen for yet takes the server defaults, but only
 * while its reset is still ahead: a stop whose window already passed (an old
 * thread when auto-resume turns on) is left for the user to resume by hand.
 */
export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (resetMs <= nowMs || (!autoResume && !snooze)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`${LIMIT_ARM_COMMAND_PREFIX}${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze,
      },
    };
  }
  if (
    !recovery.autoResume ||
    Date.parse(limitRecoveryResumeAt(recovery)) > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    ...(recovery.retryAttempt === undefined
      ? {}
      : {
          notification: {
            source: { kind: "system" as const },
            outcome: "updated" as const,
            summary: `Rate limited: retrying (attempt ${recovery.retryAttempt} of ${MAX_RATE_LIMIT_RETRIES})`,
            detail: "Continue where you left off.",
          },
        }),
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

/**
 * What the server does with a fresh limit stop it decides itself (see
 * ProjectionStore.getLimitRecoveryCandidates), before any user choice:
 * - a short-term rate limit retries on the same instance with backoff, up to
 *   MAX_RATE_LIMIT_RETRIES in a row;
 * - a delegated child that is out of retries or out of quota resumes at the
 *   reset (a spent quota) or
 *   stops and reports to its parent (a rate limit that outlasted its retries);
 * - any other thread follows the user's auto-resume defaults.
 */
export type LimitStopDecision =
  | {
      readonly type: "arm";
      readonly limitRecovery: OrchestrationV2LimitRecoveryUpdate;
    }
  | { readonly type: "delegated-resume"; readonly resume: boolean }
  | { readonly type: "defaults" };

export function decideLimitStop(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
): LimitStopDecision {
  const runId = thread.latestRunId!;
  const resetAt = thread.usageLimitResetAt!;
  if (thread.limitKind === "rate_limit") {
    const retry = nextRateLimitRetry({
      previous: thread.retryChained === false ? null : thread.limitRecovery,
      runId,
      resetAt,
      stoppedAtMs: DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt),
    });
    if (retry !== null) {
      return {
        type: "arm",
        limitRecovery: { runId, resetAt, autoResume: true, ...retry },
      };
    }
    return thread.delegated === true
      ? { type: "delegated-resume", resume: false }
      : { type: "arm", limitRecovery: { runId, resetAt, autoResume: false } };
  }
  return thread.delegated === true
    ? { type: "delegated-resume", resume: true }
    : { type: "defaults" };
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const arm = (
    thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
    limitRecovery: OrchestrationV2LimitRecoveryUpdate,
  ) => {
    const commandId = CommandId.make(
      `${LIMIT_ARM_COMMAND_PREFIX}${thread.id}:${limitRecovery.runId}:${Date.parse(limitRecovery.resetAt)}`,
    );
    return threads
      .dispatch({ type: "thread.metadata.update", commandId, threadId: thread.id, limitRecovery })
      .pipe(Effect.as(commandId));
  };

  const recoverDelegated = (
    thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
    resume: boolean,
  ) =>
    Effect.gen(function* () {
      const runId = thread.latestRunId!;
      const resetAt = thread.usageLimitResetAt!;
      const notify = (
        recovery: Parameters<typeof deliverDelegatedTaskRecoveryNotice>[0]["recovery"],
      ) =>
        deliverDelegatedTaskRecoveryNotice({
          childThreadId: thread.id,
          childRunId: runId,
          recovery,
        }).pipe(
          Effect.provideService(ThreadManagement.ThreadManagementService, threads),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.limit-recovery.parent-notice-failed", {
              threadId: thread.id,
              cause,
            }),
          ),
        );
      // A spent quota waits for its reset; a rate limit
      // that outlasted its retries stops, and its parent gets the failure.
      const armId = yield* arm(thread, { runId, resetAt, autoResume: resume });
      // A choice that landed mid-sweep keeps its own outcome; the arm left it be.
      if (resume && (yield* threads.getThreadShell(thread.id))?.limitRecovery?.requestId === armId)
        yield* notify({ type: "resuming_at_reset", at: resetAt });
    });

  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
    });
    const nowMs = DateTime.toEpochMillis(now);
    for (const thread of candidates) {
      const recorded =
        thread.limitRecovery?.runId === thread.latestRunId &&
        thread.limitRecovery?.resetAt === thread.usageLimitResetAt;
      const decision: LimitStopDecision = recorded ? { type: "defaults" } : decideLimitStop(thread);
      const step = Effect.gen(function* () {
        switch (decision.type) {
          case "arm":
            yield* arm(thread, decision.limitRecovery);
            return;
          case "delegated-resume":
            yield* recoverDelegated(thread, decision.resume);
            return;
          case "defaults": {
            const command = limitRecoveryCommand(
              thread,
              preferences.autoResumeLimitedThreads,
              nowMs,
              preferences.snoozeLimitedThreads,
            );
            if (command !== null) yield* threads.dispatch(command);
          }
        }
      });
      yield* step.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
});

// The shared scheduler derives due work from persisted failures and recovery
// choices, so restarts need no timer restoration or connected client.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);

import {
  CommandId,
  limitRecoveryResumeAt,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2LimitRecoveryUpdate,
  type OrchestrationV2Run,
  type ProviderInstanceId,
  type ThreadId,
  type UsageLimitHandoffCandidate,
} from "@cogenly/contracts";
import { runRanAfter } from "@cogenly/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as AgentStore from "../agents/AgentStore.ts";
import { fallbackChainOf } from "../agents/providerFallback.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { deliverDelegatedTaskRecoveryNotice } from "./DelegatedTaskFailureNotice.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitHandoff from "./UsageLimitHandoff.ts";
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
 * - a delegated child that is out of retries or out of quota hands off to an
 *   instance with headroom, else resumes at the reset (a spent quota) or
 *   stops and reports to its parent (a rate limit that outlasted its retries);
 * - any other thread follows the user's auto-resume defaults.
 */
export type LimitStopDecision =
  | {
      readonly type: "arm";
      readonly limitRecovery: OrchestrationV2LimitRecoveryUpdate;
    }
  | { readonly type: "hand-off-or-resume"; readonly resume: boolean }
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
      ? { type: "hand-off-or-resume", resume: false }
      : { type: "arm", limitRecovery: { runId, resetAt, autoResume: false } };
  }
  return thread.delegated === true
    ? { type: "hand-off-or-resume", resume: true }
    : { type: "defaults" };
}

/**
 * The handoff targets for a stop, best first. An agent with a fallback chain
 * keeps to it: only its entries, in its order, each with the entry's model.
 * Without one, the shared ranking stands.
 */
export function handoffTargets(
  candidates: ReadonlyArray<UsageLimitHandoffCandidate>,
  chain: ReadonlyArray<ModelSelection> | null,
): ReadonlyArray<{ readonly candidate: UsageLimitHandoffCandidate; readonly model?: string }> {
  if (chain === null || chain.length < 2) return candidates.map((candidate) => ({ candidate }));
  return chain.flatMap((entry) => {
    const candidate = candidates.find((option) => option.instanceId === entry.instanceId);
    return candidate === undefined ? [] : [{ candidate, model: entry.model }];
  });
}

/** Instances that already stopped on a limit since the thread last finished a run. */
function limitedInstancesInStreak(
  runs: ReadonlyArray<OrchestrationV2Run>,
): ReadonlySet<ProviderInstanceId> {
  const lastCompleted = runs
    .filter((run) => run.status === "completed")
    .reduce<OrchestrationV2Run | undefined>(
      (latest, run) => (latest === undefined || runRanAfter(run, latest) ? run : latest),
      undefined,
    );
  return new Set(
    runs
      .filter(
        (run) =>
          run.status === "failed" &&
          (lastCompleted === undefined || runRanAfter(run, lastCompleted)),
      )
      .map((run) => run.providerInstanceId),
  );
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const handoff = yield* UsageLimitHandoff.UsageLimitHandoffService;
  const agents = yield* Effect.serviceOption(AgentStore.AgentStore);

  // The fallback chain of the agent that owns the thread (a delegated child
  // carries its parent's agent), or null when it has none.
  const agentChain = (threadId: ThreadId) =>
    Effect.gen(function* () {
      if (Option.isNone(agents)) return null;
      const shell = yield* threads.getThreadShell(threadId);
      if (shell?.agent === undefined) return null;
      const agent = yield* agents.value.get(shell.agent.id);
      return fallbackChainOf(agent);
    }).pipe(Effect.orElseSucceed(() => null));

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

  // A delegated child has no user to pick an instance: it takes the best
  // candidate it has not already stopped on in this streak, the same ranking
  // thread_limit_handoff_options shows. An instance the machine turned off
  // refuses the dispatch, and the next candidate is tried.
  const handOff = (thread: ProjectionStore.ProjectionLimitRecoveryCandidate) =>
    Effect.gen(function* () {
      const runId = thread.latestRunId!;
      const recommendation = yield* handoff
        .recommend(thread.id)
        .pipe(Effect.orElseSucceed(() => null));
      if (recommendation === null || recommendation.runId !== runId) return null;
      const { runs } = yield* threads.getThreadRecords(thread.id, ["runs"]);
      const tried = limitedInstancesInStreak(runs);
      const targets = handoffTargets(recommendation.candidates, yield* agentChain(thread.id));
      for (const { candidate, model } of targets) {
        if (tried.has(candidate.instanceId)) continue;
        const accepted = yield* handoff
          .accept({
            threadId: thread.id,
            runId,
            instanceId: candidate.instanceId,
            ...(model === undefined ? {} : { model }),
            createdBy: "system",
            creationSource: "server",
            notification: {
              source: { kind: "system" },
              outcome: "updated",
              summary: `Limit reached on ${recommendation.from.instanceId}: continued on ${candidate.displayName ?? candidate.instanceId}`,
              detail: "Continue where you left off.",
            },
          })
          .pipe(
            Effect.map((result) => ({ ...candidate, modelSelection: result.modelSelection })),
            Effect.catch((error) =>
              Effect.logInfo("orchestration-v2.limit-recovery.handoff-refused", {
                threadId: thread.id,
                instanceId: candidate.instanceId,
                reason: error.reason,
              }).pipe(Effect.as(null)),
            ),
          );
        if (accepted !== null) return accepted;
      }
      return null;
    });

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
      // The handoff queues its parent notice in the same commit (see Orchestrator).
      if ((yield* handOff(thread)) !== null) return;
      // Nothing has headroom. A spent quota waits for its reset; a rate limit
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
          case "hand-off-or-resume":
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

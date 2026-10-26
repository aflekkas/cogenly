import { runRanAfter } from "@cogenly/shared/orchestrationV2ThreadError";
import {
  CommandId,
  latestProviderTurnForAttempt,
  MessageId,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type RunId,
  type ThreadId,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";

import * as ServerSettings from "../serverSettings.ts";
import { isNativeMaintenanceCommand } from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  isAwaitedWork,
  isRestartContinuationSource,
  isRestartNoteSource,
  restartCancelledBackgroundWorkNote,
  restartContinuationNote,
} from "./RestartBackgroundNote.ts";

const CONTINUE_PROMPT = "Continue where you left off.";

/** Consecutive automatic continuations allowed before a person has to step in. */
const MAX_CONTINUATION_CHAIN = 3;

/**
 * Whether `source` ends a chain of automatic continuations long enough that a
 * person has to step in. A turn that keeps crashing the server would
 * otherwise restart it forever.
 */
export function restartContinuationChainExhausted(
  source: OrchestrationV2Run,
  runs: ReadonlyArray<OrchestrationV2Run>,
): boolean {
  let chainLength = 0;
  for (
    let run: OrchestrationV2Run | undefined = source;
    run?.restartContinuationOfRunId !== undefined && chainLength < MAX_CONTINUATION_CHAIN;
    run = runs.find((candidate) => candidate.id === run?.restartContinuationOfRunId)
  ) {
    chainLength += 1;
  }
  return chainLength >= MAX_CONTINUATION_CHAIN;
}

/**
 * Whether a restart must leave this run for the user: the thread is put away,
 * the provider turn already ended, or the user owes an answer. Checked when
 * intent is recorded and again when the continuation is delivered. A
 * `settled` run is woken for the awaited work it lost, so its ended provider
 * turn does not block it.
 */
function restartContinuationBlocked(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    "thread" | "runtimeRequests" | "providerTurns" | "turnItems"
  >,
  source: OrchestrationV2Run,
  now: DateTime.Utc,
  settled: boolean,
): boolean {
  const { thread } = projection;
  if (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    (thread.snoozedUntil != null && DateTime.isGreaterThan(thread.snoozedUntil, now))
  )
    return true;
  const turn = latestProviderTurnForAttempt(projection.providerTurns, source.activeAttemptId);
  if (
    !settled &&
    turn !== undefined &&
    (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted")
  )
    return true;
  const waitingRequest = projection.runtimeRequests.some(
    (request) =>
      // Tool calls and auth refreshes do not wait on a person, and a
      // message-capable question stays answerable after the restart.
      request.kind !== "dynamic_tool_call" &&
      request.kind !== "auth_refresh" &&
      request.responseCapability.type !== "message" &&
      (request.status === "pending" ||
        // Recovery closes live callbacks on the cut turn; it does not answer them.
        ((request.status === "expired" || request.status === "cancelled") &&
          request.responseCapability.type === "not_resumable" &&
          turn !== undefined &&
          turn.id === request.providerTurnId)),
  );
  if (waitingRequest) return true;
  return projection.turnItems.some(
    (item) =>
      item.type === "secret_request" &&
      item.runId === source.id &&
      (item.secretStatus === "pending" ||
        // Recovery cancels an open secret card and its run at the same instant.
        (item.secretStatus === "cancelled" &&
          item.completedAt !== null &&
          source.completedAt !== null &&
          DateTime.Equivalence(item.completedAt, source.completedAt))),
  );
}

/**
 * Open awaited work (see `isAwaitedWork`) on a provider thread. App-owned
 * delegations are not counted: their own threads continue and report back.
 */
function hasOpenAwaitedWork(
  projection: Pick<ProjectionRuntimeRecoveryState, "runs" | "turnItems">,
  providerThread: ProjectionRuntimeRecoveryState["providerThreads"][number],
): boolean {
  const openItem = projection.turnItems.some((item) => {
    if (item.status !== "pending" && item.status !== "running" && item.status !== "waiting")
      return false;
    if (item.type === "subagent" && item.origin === "app_owned" && item.childThreadId !== null)
      return false;
    const work = cancelledTurnItemWork(item);
    const providerThreadId =
      item.providerThreadId ??
      projection.runs.find((run) => run.id === item.runId)?.providerThreadId;
    return work !== undefined && isAwaitedWork(work) && providerThreadId === providerThread.id;
  });
  return (
    openItem ||
    (providerThread.ownerNodeId === null &&
      (providerThread.pendingBackgroundTasks ?? []).some((task) =>
        isAwaitedWork(cancelledRosterTaskWork(task)),
      ))
  );
}

/**
 * Provider-turn statuses proving a run reached the provider: its turn went
 * live and either is still running or ended. A `pending` turn never started,
 * and `cancelled` also covers recovery cancelling a row that never went live,
 * so neither proves it on its own.
 */
const LIVE_OR_ENDED_PROVIDER_TURN_STATUS: ReadonlySet<OrchestrationV2ProviderTurn["status"]> =
  new Set(["running", "completed", "failed", "interrupted"]);

/**
 * Whether a run's provider turn went live: the run started (`startedAt` is
 * set when the turn start commits), or one of its attempts has a provider
 * turn that ran or ended. An unstarted restart continuation (dispatched by
 * an earlier restart but cut again before its turn began) never went live,
 * so continuing it once more would only stack another marker for a turn that
 * was never actually resumed.
 */
export function runReachedProvider(
  run: Pick<OrchestrationV2Run, "id" | "activeAttemptId" | "startedAt">,
  attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>,
  providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId" | "status">>,
): boolean {
  if (run.startedAt !== null) return true;
  const attemptIds = new Set(
    attempts.filter((attempt) => attempt.runId === run.id).map((attempt) => attempt.id),
  );
  if (run.activeAttemptId !== null) attemptIds.add(run.activeAttemptId);
  return providerTurns.some(
    (turn) =>
      turn.runAttemptId !== null &&
      attemptIds.has(turn.runAttemptId) &&
      LIVE_OR_ENDED_PROVIDER_TURN_STATUS.has(turn.status),
  );
}

/**
 * An unstarted restart continuation: dispatched by an earlier restart but cut
 * again before its turn began. Recovery revives it instead of chaining
 * another continuation onto it, so rapid restarts resume the turn once rather
 * than stacking a "resumed" marker per restart.
 */
export function isUnstartedRestartContinuation(
  run: Pick<
    OrchestrationV2Run,
    "id" | "status" | "activeAttemptId" | "startedAt" | "restartContinuationOfRunId"
  >,
  attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>,
  providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId" | "status">>,
): boolean {
  return (
    run.status === "starting" &&
    run.restartContinuationOfRunId !== undefined &&
    !runReachedProvider(run, attempts, providerTurns)
  );
}

/**
 * The run a restart continues: an unfinished root turn, or a settled one
 * waiting on awaited work that the restart cancels. A settled run needs a
 * live session, so stale records from an older crash never wake it. A run
 * that already has a continuation was resumed already and is never picked up
 * again, and an unstarted continuation (no live turn) is revived by recovery
 * instead of chained, so a turn that never ran stacks no markers. Other
 * leftover work is cleaned up and reported on the next user turn.
 */
export function restartContinuationRun(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    | "thread"
    | "runs"
    | "providerThreads"
    | "providerSessions"
    | "providerTurns"
    | "runtimeRequests"
    | "turnItems"
  >,
  now: DateTime.Utc,
): OrchestrationV2Run | undefined {
  // Queued runs never started; recovery holds them behind the cut run.
  const run = projection.runs.reduce<OrchestrationV2Run | undefined>(
    (latest, candidate) =>
      candidate.status !== "queued" && (!latest || runRanAfter(candidate, latest))
        ? candidate
        : latest,
    undefined,
  );
  if (!run) return;
  const settled = run.status === "completed" || run.status === "waiting";
  if (run.status !== "running" && run.status !== "starting" && !settled) return;
  // The run was already resumed once: its continuation exists, so a later
  // restart must not pick it up again. Delivery would decline it anyway (the
  // continuation message exists), but skipping here avoids an effect that
  // would gate delegated delivery while pending.
  if (projection.runs.some((candidate) => candidate.restartContinuationOfRunId === run.id)) return;
  if (restartContinuationBlocked(projection, run, now, settled)) return;
  // A starting run qualifies only with a genuinely live turn. An unstarted
  // continuation is revived by recovery instead of chained, so it is skipped
  // here: the live-turn check below excludes it.
  const liveTurnRequired = !settled;
  if (projection.thread.providerInstanceId !== run.providerInstanceId) return;
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === run.providerThreadId,
  );
  if (
    !providerThread ||
    providerThread.appThreadId !== projection.thread.id ||
    providerThread.ownerNodeId !== null ||
    providerThread.providerInstanceId !== run.providerInstanceId ||
    providerThread.nativeThreadRef?.nativeId == null ||
    providerThread.nativeThreadRef.strength !== "strong" ||
    providerThread.nativeThreadRef.driver !== providerThread.driver ||
    (liveTurnRequired && providerThread.status !== "active") ||
    providerThread.status === "closed" ||
    providerThread.status === "archived"
  )
    return;
  const session = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread.providerSessionId,
  );
  // Most adapters keep a live session "ready" through its turns, so only a
  // stopped or failed session rules out a live turn.
  if (
    session === undefined ||
    session.providerInstanceId !== run.providerInstanceId ||
    session.driver !== providerThread.driver ||
    session.status === "stopped" ||
    session.status === "error"
  )
    return;
  if (settled) return hasOpenAwaitedWork(projection, providerThread) ? run : undefined;
  if (
    liveTurnRequired &&
    !projection.providerTurns.some(
      (turn) =>
        turn.providerThreadId === providerThread.id &&
        turn.runAttemptId === run.activeAttemptId &&
        turn.status === "running",
    )
  )
    return;
  return run;
}

export const continueRestartedRun = Effect.fn("RestartContinuation.continueRestartedRun")(
  function* (input: { readonly threadId: ThreadId; readonly sourceRunId: RunId }) {
    const settings = yield* ServerSettings.ServerSettingsService;
    const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!enabled?.continueThreadsAfterServerUpdate) return;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const messageId = MessageId.make(`message:restart-continuation:${input.sourceRunId}`);
    const projection = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "runs", "providerTurns", "attempts", "runtimeRequests", "turnItems"],
      { messageIds: [messageId], turnItemTypes: ["secret_request"] },
    );
    if (projection.messages.some((message) => message.id === messageId)) return;
    const source = projection.runs.find((run) => run.id === input.sourceRunId);
    // Reconciliation cancels a waiting run it cannot checkpoint, so a settled
    // source can be cancelled too. It continues only for awaited work.
    if (
      !source ||
      !isRestartContinuationSource(source, projection.providerTurns) ||
      restartContinuationBlocked(
        projection,
        source,
        yield* DateTime.now,
        isRestartNoteSource(source, projection.providerTurns),
      )
    )
      return;
    // A source that never reached the provider is an unstarted continuation
    // cut by a later restart, or a stale effect for one: chaining it would
    // stack another "resumed" marker without resuming anything. Recovery
    // revives the unstarted run itself instead.
    if (
      !isRestartNoteSource(source, projection.providerTurns) &&
      !runReachedProvider(source, projection.attempts, projection.providerTurns)
    ) {
      yield* Effect.logInfo("orchestration-v2.restart-continuation.source-never-started", {
        threadId: input.threadId,
        sourceRunId: input.sourceRunId,
      });
      return;
    }
    // A user submission after reconciliation takes precedence over an automatic
    // prompt. Queued runs never started and stay held behind this one.
    if (
      projection.runs.some(
        (run) => run.id !== source.id && run.status !== "queued" && runRanAfter(run, source),
      )
    )
      return;
    if (projection.thread.providerInstanceId !== source.providerInstanceId) return;
    if (restartContinuationChainExhausted(source, projection.runs)) {
      yield* Effect.logWarning("Not continuing a run restarted too many times in a row", {
        threadId: input.threadId,
        sourceRunId: input.sourceRunId,
      });
      return;
    }
    const sourceRecords = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "turnItems"],
      {
        messageIds: [source.userMessageId],
        turnItemRunIds: [source.id],
        turnItemTypes: ["run_interrupt_request"],
      },
    );
    // The user asked this run to stop before the restart cut it.
    if (
      sourceRecords.turnItems.some(
        (item) => item.runId === source.id && item.type === "run_interrupt_request",
      )
    )
      return;
    const sourceMessage = sourceRecords.messages.find(
      (message) => message.id === source.userMessageId,
    );
    if (sourceMessage !== undefined && isNativeMaintenanceCommand(sourceMessage)) return;
    const note = restartContinuationNote(
      source,
      projection.runs,
      projection.providerTurns,
      projection.attempts,
    );
    const noteText =
      note.work.length === 0 ? undefined : restartCancelledBackgroundWorkNote(note.work);
    const text =
      noteText === undefined
        ? CONTINUE_PROMPT
        : note.settled
          ? noteText
          : `${noteText}\n\n${CONTINUE_PROMPT}`;
    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:restart-continuation:${input.sourceRunId}`),
        threadId: input.threadId,
        messageId,
        text,
        // Shown as a work log row; the prompt the agent got is its detail.
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary: note.settled
            ? "Cogenly restarted and stopped background work"
            : "Cogenly restarted and resumed this turn",
          detail: text,
        },
        attachments: [],
        modelSelection: source.modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        restartContinuationOfRunId: input.sourceRunId,
      })
      .pipe(
        // The machine turned this instance off since the restart. No turn
        // resumes, and the success path below still runs so a delegated
        // child waiting on this run is recovered immediately instead of
        // after EffectWorker exhausts its retries on a refusal that will
        // not change.
        Effect.catchTags({
          ThreadManagementProviderInstanceDisabledError: (error) =>
            Effect.logInfo("orchestration-v2.restart-continuation.instance-disabled", {
              threadId: input.threadId,
              sourceRunId: input.sourceRunId,
              projectId: error.projectId,
              instanceId: error.instanceId,
            }),
        }),
      );
  },
  // A delegated child this declined to continue still owes its parent a
  // result. Once a continuation run exists this is a no-op; that run settles it.
  (effect, input) =>
    effect.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          yield* threads.recoverDelegatedTask(input.threadId, input.sourceRunId);
        }),
      ),
    ),
);

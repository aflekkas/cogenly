import { ThreadId, type OrchestrationV2ThreadShell } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as AgentProcessControl from "./AgentProcessControl.ts";
import * as AgentProcesses from "./AgentProcesses.ts";

/** A command outlives its thread's last sign of life by this long before it is reaped. */
export const IDLE_REAP_AFTER_MS = 4 * 60 * 60_000;
const SWEEP_EVERY = "10 minutes";

type ReaperShell = Pick<
  OrchestrationV2ThreadShell,
  | "archivedAt"
  | "settledOverride"
  | "activeRunId"
  | "latestRunCompletedAt"
  | "latestUserMessageAt"
  | "lastVisitedAt"
>;

const millis = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.toEpochMillis(value);

/**
 * Why a command an agent started should be reaped now, or null to keep it.
 * Kept commands and ones from an earlier server (orphans, which machine
 * health offers to kill) are never reaped here. A thread that is gone,
 * archived or settled has no use for them; an idle thread keeps them until
 * nothing happened in it, including the user looking at it, for
 * {@link IDLE_REAP_AFTER_MS}.
 */
export function reapReason(
  record: Pick<AgentProcesses.AgentProcessView, "keepRunning" | "orphaned" | "startedAt" | "kind">,
  shell: ReaperShell | null,
  nowMs: number,
): "stopped" | "idle" | null {
  // Provider CLIs belong to their session manager, which releases idle ones itself.
  if (record.keepRunning || record.orphaned || record.kind !== "terminal") return null;
  if (shell !== null && shell.activeRunId !== null) return null;
  if (shell === null || shell.archivedAt !== null || shell.settledOverride === "settled") {
    return "stopped";
  }
  const lastActivity = Math.max(
    Option.match(DateTime.make(record.startedAt), {
      onNone: () => 0,
      onSome: DateTime.toEpochMillis,
    }),
    millis(shell.latestRunCompletedAt) ?? 0,
    millis(shell.latestUserMessageAt) ?? 0,
    millis(shell.lastVisitedAt) ?? 0,
  );
  return nowMs - lastActivity >= IDLE_REAP_AFTER_MS ? "idle" : null;
}

/** One sweep: kills every live command whose thread no longer needs it. */
export const reapOnce = Effect.fn("AgentProcessReaper.reapOnce")(function* () {
  const processes = yield* AgentProcesses.AgentProcesses;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const control = yield* AgentProcessControl.AgentProcessControl;
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  const { processes: live } = yield* processes.snapshot;
  const reaped: Array<{ readonly threadId: string; readonly terminalId: string }> = [];
  for (const record of live) {
    const shell = yield* projections
      .getThreadShell(ThreadId.make(record.threadId))
      // An unreadable thread is not proof it is gone.
      .pipe(Effect.orElseSucceed(() => undefined));
    if (shell === undefined) continue;
    const reason = reapReason(record, shell, nowMs);
    if (reason === null) continue;
    const target = { threadId: record.threadId, terminalId: record.terminalId, reason };
    yield* control.kill(target);
    reaped.push(target);
  }
  return reaped;
});

/** Sweeps every ten minutes for the life of the server. */
export const layer = Layer.effectDiscard(
  reapOnce().pipe(
    Effect.catchCause((cause) => Effect.logWarning("Reaping agent processes failed", { cause })),
    Effect.repeat(Schedule.spaced(SWEEP_EVERY)),
    Effect.delay(SWEEP_EVERY),
    Effect.forkScoped,
  ),
);

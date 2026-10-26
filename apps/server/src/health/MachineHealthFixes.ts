/**
 * MachineHealthFixes: the Fix behind a health item, for every transport
 * (WebSocket `machines.healthFix`, MCP `machine_health_fix`, and a paired
 * machine over `MachineHealthFixRun`). It always runs on the machine the item
 * is on: a request for another machine is forwarded over the peer link, and
 * the items are read again from that machine's own report, so a stale client
 * can never run a fix the item no longer asks for.
 */
import {
  CommandId,
  type EnvironmentId,
  MachineHealthError,
  type MachineHealthFixInput,
  type MachineHealthFixOutcome,
  type MachineHealthFixResult,
  MachineHealthFixRun,
  MachineVersionUpdate,
  type MachineHealthItem,
  type ThreadId,
  isOrchestrationV2WorkActive,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import { compareExactServiceVersions, isExactServiceVersion } from "../cloud/serviceProtocol.ts";
import * as MachineIdentity from "../machines/MachineIdentity.ts";
import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as MachineHealth from "./MachineHealth.ts";
import { STUCK_RUN_AFTER_MS, newestMachineVersion } from "./healthChecks.ts";
import { readStaleRuns } from "./staleRuns.ts";

export class MachineHealthFixes extends Context.Service<
  MachineHealthFixes,
  {
    readonly fix: (
      input: MachineHealthFixInput,
    ) => Effect.Effect<MachineHealthFixResult, MachineHealthError>;
  }
>()("cogenly-server/health/MachineHealthFixes") {}

/** Fixes that stop runs or retry sync can take a while; the peer waits this long. */
const PEER_FIX_TIMEOUT = Duration.seconds(90);

const STOP_REASON = "Stopped by machine health: it had stopped responding.";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** One or two sentences for the whole request, from each item's outcome. */
export function summarizeFixOutcomes(outcomes: ReadonlyArray<MachineHealthFixOutcome>): string {
  if (outcomes.length === 1) return outcomes[0]?.message ?? "";
  const count = (status: MachineHealthFixOutcome["status"]) =>
    outcomes.filter((outcome) => outcome.status === status).length;
  const parts = [
    count("fixed") > 0 ? `Fixed ${count("fixed")} of ${outcomes.length}.` : null,
    count("resolved") > 0 ? `${count("resolved")} had already cleared.` : null,
    count("failed") > 0 ? `${count("failed")} couldn't be fixed.` : null,
    count("manual") > 0 ? `${count("manual")} need an agent or you to look.` : null,
  ];
  return parts.filter((part) => part !== null).join(" ");
}

const make = Effect.gen(function* () {
  const health = yield* MachineHealth.MachineHealth;
  const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
  const machines = yield* Machines.Machines;
  const channels = yield* PeerChannels.PeerChannels;
  const identity = yield* MachineIdentity.MachineIdentity;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const commandId = (suffix: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.map((id) => CommandId.make(`command:health-fix:${id}:${suffix}`)),
      Effect.orDie,
    );

  /**
   * Stops a thread's stale work: the specific stale turns and every stale
   * delegated task's child thread, then ends whatever no live work will end.
   * Never resumes: work that lost its provider session can't pick up where it
   * was, and resuming would repeat it; the thread's agent continues on the
   * next message.
   */
  const stopStaleRuns = (threadId: ThreadId, itemKey: string) =>
    Effect.gen(function* () {
      const stale = yield* readStaleRuns(yield* DateTime.now, threadId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      const records = yield* threads.getThreadRecords(threadId, ["runs", "subagents"]);
      const staleSubagentIds = new Set(
        stale.filter((run) => run.kind === "subagent").map((run) => run.id),
      );
      const staleSubagents = records.subagents.filter((task) => staleSubagentIds.has(task.id));
      const staleRunIds = new Set(stale.filter((run) => run.kind === "run").map((run) => run.id));
      const staleRuns = records.runs.filter((run) => staleRunIds.has(run.id));
      const activeRun = staleRuns.length > 0;
      if (stale.length === 0) {
        return {
          itemKey,
          status: "resolved",
          message: "Nothing is stuck there any more.",
        } as const;
      }
      const failures: Array<unknown> = [];
      const attempt = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.asVoid,
          Effect.catch((error) => Effect.sync(() => void failures.push(error))),
        );
      const unreachableChildThreadIds: Array<ThreadId> = [];
      for (const task of staleSubagents) {
        if (task.origin !== "app_owned" || task.childThreadId === null) continue;
        const child = task.childThreadId;
        const stopId = yield* commandId(`stop:${child}`);
        const childRecords = yield* threads.getThreadRecords(child, ["runs"]);
        const cutoff = DateTime.toEpochMillis(yield* DateTime.now) - STUCK_RUN_AFTER_MS;
        const childRunIds = childRecords.runs
          .filter(
            (run) =>
              ["preparing", "starting", "running"].includes(run.status) &&
              DateTime.toEpochMillis(run.requestedAt) < cutoff,
          )
          .map((run) => run.id);
        // Routed to the child's owner when another machine runs it.
        const stopped = yield* threads
          .dispatch({
            type: "thread.stale-work.settle",
            commandId: stopId,
            threadId: child,
            runIds: childRunIds,
            subagentIds: [],
            reason: STOP_REASON,
          })
          .pipe(Effect.result);
        if (Result.isFailure(stopped)) {
          failures.push(stopped.failure);
          if (stopped.failure._tag === "ThreadRemoteError") unreachableChildThreadIds.push(child);
        }
      }
      if (activeRun || staleSubagents.length > 0) {
        yield* attempt(
          threads.dispatch({
            type: "thread.stale-work.settle",
            commandId: yield* commandId(`settle:${threadId}`),
            threadId,
            subagentIds: staleSubagents.map((task) => task.id),
            runIds: staleRuns.map((run) => run.id),
            reason: STOP_REASON,
            unreachableChildThreadIds,
          }),
        );
      }
      if (failures.length > 0) {
        yield* Effect.logWarning("Machine health could not stop every stale run", {
          threadId,
          failures,
        });
      }
      const after = yield* threads.getThreadRecords(threadId, ["runs", "subagents"]);
      const stillActive = after.subagents.filter(
        (task) => staleSubagentIds.has(task.id) && isOrchestrationV2WorkActive(task.status),
      ).length;
      const runStillActive = after.runs.some(
        (run) =>
          staleRunIds.has(run.id) &&
          (run.status === "preparing" || run.status === "starting" || run.status === "running"),
      );
      const stopped = staleSubagents.length - stillActive;
      const what = [
        activeRun ? "its turn" : null,
        staleSubagents.length > 0 ? plural(staleSubagents.length, "stuck subagent") : null,
      ]
        .filter((part) => part !== null)
        .join(" and ");
      if (stillActive === 0 && !runStillActive) {
        return {
          itemKey,
          status: "fixed",
          message: `Stopped ${what}. They had lost their provider sessions, so they couldn't be resumed; send the thread a message to continue the work.`,
        } as const;
      }
      return {
        itemKey,
        status: stopped > 0 || (activeRun && !runStillActive) ? "fixed" : "failed",
        message: `Asked ${what} to stop; ${
          runStillActive && stillActive > 0
            ? `the turn and ${plural(stillActive, "subagent")} are`
            : runStillActive
              ? "the turn is"
              : `${plural(stillActive, "subagent")} ${stillActive === 1 ? "is" : "are"}`
        } still stopping. Open the thread if they don't finish shortly.`,
      } as const;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Machine health could not stop stale runs", { threadId, error }).pipe(
          Effect.as({
            itemKey,
            status: "failed",
            message: "Couldn't stop the stuck runs. Open the thread to stop them from there.",
          } as const),
        ),
      ),
    );

  const updateHere = (targetVersion: string) =>
    Effect.gen(function* () {
      const self = yield* identity.self;
      const view = yield* machines.list.pipe(
        Effect.mapError((cause) => new MachineHealthError({ reason: "unavailable", cause })),
      );
      if (
        selfUpdate.capability !== "boot-service" ||
        !isExactServiceVersion(targetVersion) ||
        !isExactServiceVersion(self.serverVersion) ||
        targetVersion !== newestMachineVersion(view.machines) ||
        compareExactServiceVersions(targetVersion, self.serverVersion) <= 0
      ) {
        return yield* new MachineHealthError({ reason: "unavailable" });
      }
      yield* selfUpdate
        .update({ targetVersion })
        .pipe(Effect.mapError((cause) => new MachineHealthError({ reason: "unavailable", cause })));
      return {};
    });
  yield* channels.register(MachineVersionUpdate, ({ targetVersion }) => updateHere(targetVersion));

  const runFix = (item: MachineHealthItem): Effect.Effect<MachineHealthFixOutcome> => {
    const itemKey = item.key;
    const target = item.target;
    const failed = (message: string) => ({ itemKey, status: "failed", message }) as const;
    switch (item.fix) {
      case null:
        return Effect.succeed({
          itemKey,
          status: "manual",
          message: "There's no direct fix for this; an agent has to investigate it.",
        });
      case "sign-in":
        return Effect.succeed({
          itemKey,
          status: "manual",
          message:
            target?._tag === "integration"
              ? "Sign in again from Settings → Integrations on this machine."
              : "Sign in again from Settings → Providers on this machine.",
        });
      case "run-now":
        return target?._tag !== "scheduledTask"
          ? Effect.succeed(failed("The task to run is missing."))
          : scheduledTasks.runNow({ id: target.taskId }).pipe(
              Effect.as({ itemKey, status: "fixed", message: "Started a new run." } as const),
              Effect.catch((error) => Effect.succeed(failed(error.message))),
            );
      case "retry-sync":
        return target?._tag !== "machine"
          ? Effect.succeed(failed("The machine to sync with is missing."))
          : health.retrySync({ environmentId: target.environmentId }).pipe(
              Effect.as({ itemKey, status: "fixed", message: "Sync ran again." } as const),
              Effect.catch((error) => Effect.succeed(failed(error.message))),
            );
      case "update-machine":
        return Effect.gen(function* () {
          if (target?._tag !== "machine") return failed("The machine to update is missing.");
          const view = yield* machines.list;
          const targetVersion = newestMachineVersion(view.machines);
          if (targetVersion === undefined) return failed("The target version is unknown.");
          const self = yield* identity.self;
          if (target.environmentId === self.environmentId) yield* updateHere(targetVersion);
          else
            yield* machines
              .call(target.environmentId, MachineVersionUpdate, { targetVersion })
              .pipe(Effect.timeout(PEER_FIX_TIMEOUT));
          return {
            itemKey,
            status: "fixed",
            message: `Started updating to ${targetVersion}.`,
          } as const;
        }).pipe(
          Effect.catch(() => Effect.succeed(failed("The machine update could not be started."))),
        );
      case "setup-sandbox":
        return health.setupSandbox.pipe(
          Effect.map((result) =>
            result.available
              ? ({ itemKey, status: "fixed", message: result.message } as const)
              : failed(result.message),
          ),
        );
      case "resume":
      case "stop-runs":
        return target?._tag !== "thread"
          ? Effect.succeed(failed("The thread to stop is missing."))
          : stopStaleRuns(target.threadId, itemKey);
    }
  };

  const fixHere = Effect.fn("MachineHealthFixes.fixHere")(function* (
    itemKeys: ReadonlyArray<string>,
  ) {
    const report = yield* health.report;
    const items = new Map(
      report.checks.flatMap((entry) => entry.items).map((entry) => [entry.key, entry] as const),
    );
    const outcomes: Array<MachineHealthFixOutcome> = [];
    for (const itemKey of new Set(itemKeys)) {
      const entry = items.get(itemKey);
      outcomes.push(
        entry === undefined || entry.status === "ok"
          ? { itemKey, status: "resolved", message: "This has already cleared." }
          : yield* runFix(entry),
      );
    }
    // A fresh report, so alerts and Settings catch up without waiting a round.
    yield* health.report;
    return {
      environmentId: report.environmentId,
      machineName: report.machineName,
      summary: summarizeFixOutcomes(outcomes),
      outcomes,
    } satisfies MachineHealthFixResult;
  });

  yield* channels.register(MachineHealthFixRun, (payload) => fixHere(payload.itemKeys));

  const fixThere = (environmentId: EnvironmentId, itemKeys: ReadonlyArray<string>) =>
    machines.call(environmentId, MachineHealthFixRun, { itemKeys }).pipe(
      Effect.timeout(PEER_FIX_TIMEOUT),
      // Offline, an older Cogenly without Fix, or a fix that timed out there.
      Effect.mapError((cause) => new MachineHealthError({ reason: "unavailable", cause })),
    );

  const fix: MachineHealthFixes["Service"]["fix"] = Effect.fn("MachineHealthFixes.fix")(
    function* (input) {
      const self = yield* identity.self;
      if (input.environmentId === undefined || input.environmentId === self.environmentId) {
        return yield* fixHere(input.itemKeys);
      }
      const view = yield* machines.list.pipe(
        Effect.mapError((cause) => new MachineHealthError({ reason: "unavailable", cause })),
      );
      const machine = view.machines.find(
        (candidate) =>
          candidate.environmentId === input.environmentId &&
          (candidate.relation === "hub" || candidate.relation === "spoke"),
      );
      if (machine === undefined) return yield* new MachineHealthError({ reason: "not-paired" });
      return yield* fixThere(machine.environmentId, input.itemKeys);
    },
  );

  return MachineHealthFixes.of({ fix });
});

export const layer = Layer.effect(MachineHealthFixes, make);

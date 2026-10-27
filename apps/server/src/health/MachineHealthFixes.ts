/**
 * MachineHealthFixes: the Fix behind a health item, and turning off a provider
 * that isn't signed in, for every transport (WebSocket `machines.healthFix`,
 * MCP `machine_health_fix`, and a paired machine over `MachineHealthFixRun` or
 * `MachineHealthTurnOffProviderRun`). It always runs on the machine the item
 * is on: a request for another machine is forwarded over the peer link, and
 * the items are read again from that machine's own report, so a stale client
 * can never run a fix the item no longer asks for.
 */
import {
  AuthProvidersManageScope,
  CommandId,
  type EnvironmentId,
  MachineHealthError,
  type MachineHealthFixAction,
  type MachineHealthFixInput,
  type MachineHealthFixOutcome,
  type MachineHealthFixResult,
  MachineHealthFixRun,
  MachineHealthTurnOffProviderRun,
  MachineVersionUpdate,
  MachineVersionAutoUpdate,
  ProviderDriverKind,
  requiredScopeForMachineHealthFix,
  type AuthEnvironmentScope,
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

import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import { compareExactServiceVersions, isExactServiceVersion } from "../cloud/serviceProtocol.ts";
import * as MachineIdentity from "../machines/MachineIdentity.ts";
import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentProcesses from "../process/AgentProcesses.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { HEALTH_ALERT_EVALUATE_EVERY } from "./HealthAlerts.ts";
import * as HealthAlertsState from "./HealthAlertsState.ts";
import {
  AutoFixAttempt,
  healthAutoFixView,
  isAutoFixable,
  type HealthAutoFixState,
  planHealthAutoFix,
  recordHealthAutoFix,
} from "./healthAutoFix.ts";
import * as MachineHealth from "./MachineHealth.ts";
import { STUCK_RUN_AFTER_MS, newestMachineVersion } from "./healthChecks.ts";
import { readStaleRuns } from "./staleRuns.ts";

export class MachineHealthFixes extends Context.Service<
  MachineHealthFixes,
  {
    /**
     * `callerScopes` is the original caller's authority: each selected fix is
     * checked against its own required scope before it runs here or is
     * forwarded to a peer. Omit only for owner-equivalent internal callers.
     */
    readonly fix: (
      input: MachineHealthFixInput,
      callerScopes?: ReadonlyArray<AuthEnvironmentScope>,
    ) => Effect.Effect<MachineHealthFixResult, MachineHealthError>;
    /**
     * One automatic round on this machine's own report, when the machine's
     * "Fix problems automatically" setting is on: runs the safe fixes that are
     * due (see healthAutoFix.ts) and tells HealthAlerts which items to hold
     * back and which failed. Returns the outcomes of the fixes it ran.
     */
    readonly autoFix: Effect.Effect<ReadonlyArray<MachineHealthFixOutcome>>;
  }
>()("cogenly-server/health/MachineHealthFixes") {}

/** Fixes that stop runs or retry sync can take a while; the peer waits this long. */
const PEER_FIX_TIMEOUT = Duration.seconds(90);

const decodeAutoFixAttempt = Schema.decodeEffect(Schema.fromJsonString(AutoFixAttempt));

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
  const agentProcesses = yield* AgentProcesses.AgentProcesses;
  const browser = yield* Effect.serviceOption(PreviewBrowser.PreviewBrowser);
  const settings = yield* ServerSettings.ServerSettingsService;
  const alertsState = yield* HealthAlertsState.HealthAlertsState;
  const scheduler = yield* Scheduler.Scheduler;

  const autoFixLock = yield* Semaphore.make(1);

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
   * next message. `automatic` leaves work whose provider session is still
   * live running: only the owner or an agent stops a long run that is working.
   */
  const stopStaleRuns = (threadId: ThreadId, itemKey: string, automatic: boolean) =>
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
            ...(automatic ? { keepLiveSessions: true } : {}),
          })
          .pipe(Effect.result);
        if (Result.isFailure(stopped)) {
          failures.push(stopped.failure);
          if (automatic || stopped.failure._tag === "ThreadRemoteError")
            unreachableChildThreadIds.push(child);
        }
      }
      if (activeRun || staleSubagents.length > 0) {
        yield* attempt(
          threads.dispatch({
            type: "thread.stale-work.settle",
            commandId: yield* commandId(`settle:${threadId}`),
            threadId,
            subagentIds: staleSubagents
              .filter(
                (task) =>
                  !automatic ||
                  task.childThreadId === null ||
                  !unreachableChildThreadIds.includes(task.childThreadId),
              )
              .map((task) => task.id),
            runIds: staleRuns.map((run) => run.id),
            reason: STOP_REASON,
            ...(automatic ? {} : { unreachableChildThreadIds }),
            ...(automatic ? { keepLiveSessions: true } : {}),
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
      if (automatic) {
        return {
          itemKey,
          status: "failed",
          message:
            "It still has a live provider session, so it was left running. Open the thread to stop it if it's stuck.",
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

  const updateHere = (targetVersion: string, automatic = false) =>
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
      if (automatic) {
        // Read on the destination immediately before handing off to the launcher.
        // Replicated work belongs to another server and cannot be interrupted here.
        const active = yield* sql`SELECT 1 FROM orchestration_v2_projection_runs r
          WHERE (r.status IN ('preparing', 'starting', 'running', 'waiting')
            OR (r.status = 'queued' AND COALESCE(json_extract(r.payload_json, '$.queueHeld'), 0) <> 1))
            AND NOT EXISTS (SELECT 1 FROM thread_owners o WHERE o.thread_id = r.thread_id AND o.local = 0)
          UNION ALL SELECT 1 FROM orchestration_v2_projection_subagents s
          WHERE s.status IN ('pending', 'running', 'waiting')
            AND NOT EXISTS (SELECT 1 FROM thread_owners o WHERE o.thread_id = s.thread_id AND o.local = 0)
          LIMIT 1`.pipe(
          Effect.mapError((cause) => new MachineHealthError({ reason: "unavailable", cause })),
        );
        if (active.length > 0) return { started: false };
      }
      yield* selfUpdate
        .update({ targetVersion })
        .pipe(Effect.mapError((cause) => new MachineHealthError({ reason: "unavailable", cause })));
      return { started: true };
    });
  yield* channels.register(MachineVersionUpdate, ({ targetVersion }) => updateHere(targetVersion));
  yield* channels.register(MachineVersionAutoUpdate, ({ targetVersion }) =>
    updateHere(targetVersion, true),
  );

  const runFix = (
    item: MachineHealthItem,
    automatic = false,
  ): Effect.Effect<MachineHealthFixOutcome> => {
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
      case "setup-browser":
        if (itemKey === "preview-browser:host")
          return Effect.succeed({ itemKey, status: "manual", message: item.detail } as const);
        return Option.isNone(browser)
          ? Effect.succeed(failed("Browser setup is unavailable on this server."))
          : browser.value.executable.pipe(
              Effect.as({
                itemKey,
                status: "fixed",
                message: "The preview browser is installed. Try opening it again.",
              } as const),
              Effect.catchTags({
                PreviewBrowserInstallingError: (error) =>
                  Effect.succeed({ itemKey, status: "manual", message: error.message } as const),
                PreviewBrowserInstallError: (error) => Effect.succeed(failed(error.message)),
                PreviewBrowserUnsupportedError: (error) => Effect.succeed(failed(error.message)),
              }),
            );
      case "run-now":
        return target?._tag !== "scheduledTask"
          ? Effect.succeed(failed("The task to run is missing."))
          : scheduledTasks.runNow({ id: target.taskId }).pipe(
              Effect.as({ itemKey, status: "fixed", message: "Started a new run." } as const),
              Effect.catch((error) => Effect.succeed(failed(error.message))),
            );
      case "discard-quarantined":
        return target?._tag !== "thread"
          ? Effect.succeed(failed("The thread to discard incoming changes for is missing."))
          : health.discardQuarantined(target.threadId).pipe(
              Effect.map((count) => ({
                itemKey,
                status: "fixed" as const,
                message: `Discarded ${count} quarantined incoming items for ${item.title.replace("Discard quarantined changes for ", "")}. Local thread data was kept.`,
              })),
              Effect.catch(() =>
                Effect.succeed(failed("Quarantined changes could not be discarded.")),
              ),
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
      case "send-queue":
        return target?._tag !== "thread"
          ? Effect.succeed(failed("The thread to send to is missing."))
          : Effect.gen(function* () {
              yield* threads.dispatch({
                type: "queue.resume",
                threadId: target.threadId,
                commandId: yield* commandId(`queue:${target.threadId}`),
              });
              return { itemKey, status: "fixed", message: "Started the queued messages." } as const;
            }).pipe(Effect.catch(() => Effect.succeed(failed("The queue could not be sent."))));
      case "resume":
      case "stop-runs":
        return target?._tag !== "thread"
          ? Effect.succeed(failed("The thread to stop is missing."))
          : stopStaleRuns(target.threadId, itemKey, automatic);
      case "kill-orphans":
        return agentProcesses.killOrphans.pipe(
          Effect.map(
            (pids) =>
              ({
                itemKey,
                status: "fixed",
                message:
                  pids.length === 0
                    ? "They had already exited."
                    : `Killed ${pids.length} ${pids.length === 1 ? "process" : "processes"}.`,
              }) as const,
          ),
        );
    }
  };

  /**
   * Turns off the provider a `sign-in` item names, in this machine's own
   * settings. `enabled` never syncs (see providerSettingsDocument.ts), so the
   * provider stays on for every other machine. Written to the stored settings,
   * not the materialized ones, so no secret lands in the file in plain text.
   */
  const turnOffProvider = (
    item: MachineHealthItem,
    machineName: string,
  ): Effect.Effect<MachineHealthFixOutcome> => {
    const itemKey = item.key;
    const target = item.target;
    if (item.fix !== "sign-in" || target?._tag !== "provider") {
      return Effect.succeed({
        itemKey,
        status: "failed",
        message: "Only a provider that isn't signed in can be turned off from machine health.",
      });
    }
    const { instanceId } = target;
    let name: string = instanceId;
    return settings
      .updateStoredSettings((current) => {
        // Absent from settings means a built-in default, whose driver is its id.
        const instance = current.providerInstances[instanceId] ?? {
          driver: ProviderDriverKind.make(instanceId),
        };
        name = instance.displayName ?? instanceId;
        return {
          ...current,
          providerInstances: {
            ...current.providerInstances,
            [instanceId]: { ...instance, enabled: false },
          },
        };
      })
      .pipe(
        Effect.map(
          () =>
            ({
              itemKey,
              status: "fixed",
              message: `Turned off ${name} on ${machineName}. It stays on for your other machines; turn it back on in Settings → Providers.`,
            }) as const,
        ),
        Effect.catch((error) =>
          Effect.logWarning("Machine health could not turn off a provider", {
            instanceId,
            error,
          }).pipe(
            Effect.as({
              itemKey,
              status: "failed",
              message: `Couldn't turn off ${name}. Turn it off in Settings → Providers on ${machineName}.`,
            } as const),
          ),
        ),
      );
  };

  const fixHere = Effect.fn("MachineHealthFixes.fixHere")(function* (
    itemKeys: ReadonlyArray<string>,
    callerScopes?: ReadonlyArray<AuthEnvironmentScope>,
    action: MachineHealthFixAction = "fix",
  ) {
    const report = yield* health.report;
    const items = new Map(
      report.checks.flatMap((entry) => entry.items).map((entry) => [entry.key, entry] as const),
    );
    const outcomes: Array<MachineHealthFixOutcome> = [];
    for (const itemKey of new Set(itemKeys)) {
      const entry = items.get(itemKey);
      if (entry !== undefined && entry.status !== "ok" && callerScopes !== undefined) {
        const required =
          action === "turn-off-provider"
            ? AuthProvidersManageScope
            : requiredScopeForMachineHealthFix(entry.fix);
        if (!callerScopes.includes(required)) {
          outcomes.push({
            itemKey,
            status: "failed",
            message: `This fix needs the ${required} permission, which the caller does not have.`,
          });
          continue;
        }
      }
      yield* resetAutoFix([itemKey]).pipe(
        Effect.mapError((cause) => new MachineHealthError({ reason: "unavailable", cause })),
      );
      outcomes.push(
        entry === undefined || entry.status === "ok"
          ? { itemKey, status: "resolved", message: "This has already cleared." }
          : action === "turn-off-provider"
            ? yield* turnOffProvider(entry, report.machineName)
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
  }, autoFixLock.withPermits(1));

  yield* channels.register(MachineHealthFixRun, (payload) =>
    fixHere(payload.itemKeys, payload.callerScopes),
  );
  yield* channels.register(MachineHealthTurnOffProviderRun, (payload) =>
    fixHere(payload.itemKeys, payload.callerScopes, "turn-off-provider"),
  );

  const fixThere = (
    environmentId: EnvironmentId,
    itemKeys: ReadonlyArray<string>,
    callerScopes: ReadonlyArray<AuthEnvironmentScope> | undefined,
    action: MachineHealthFixAction,
  ) =>
    machines
      .call(
        environmentId,
        action === "turn-off-provider" ? MachineHealthTurnOffProviderRun : MachineHealthFixRun,
        {
          itemKeys,
          ...(callerScopes === undefined ? {} : { callerScopes: [...callerScopes] }),
        },
      )
      .pipe(
        Effect.timeout(PEER_FIX_TIMEOUT),
        // Offline, an older Cogenly without Fix, or a fix that timed out there.
        Effect.mapError((cause) => new MachineHealthError({ reason: "unavailable", cause })),
      );

  const fix: MachineHealthFixes["Service"]["fix"] = Effect.fn("MachineHealthFixes.fix")(
    function* (input, callerScopes) {
      const self = yield* identity.self;
      if (input.environmentId === undefined || input.environmentId === self.environmentId) {
        return yield* fixHere(input.itemKeys, callerScopes, input.action);
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
      return yield* fixThere(
        machine.environmentId,
        input.itemKeys,
        callerScopes,
        input.action ?? "fix",
      );
    },
  );

  const readAutoFixState = sql<{
    item_key: string;
    value_json: string;
  }>`SELECT item_key, value_json FROM health_auto_fix_attempts`.pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        decodeAutoFixAttempt(row.value_json).pipe(
          Effect.map((value) => [row.item_key, value] as const),
        ),
      ),
    ),
    Effect.map((entries): HealthAutoFixState => new Map(entries)),
  );
  const saveAutoFixState = (state: HealthAutoFixState) =>
    sql.withTransaction(
      Effect.forEach(
        state,
        ([key, value]) =>
          sql`INSERT INTO health_auto_fix_attempts(item_key, value_json) VALUES (${key}, ${JSON.stringify(value)})
        ON CONFLICT(item_key) DO UPDATE SET value_json = excluded.value_json
        WHERE health_auto_fix_attempts.value_json <> excluded.value_json`,
        { discard: true },
      ),
    );
  const resetAutoFix = (keys: ReadonlyArray<string>) =>
    Effect.forEach(
      keys,
      (key) => sql`DELETE FROM health_auto_fix_attempts WHERE item_key = ${key}`,
      { discard: true },
    );
  const autoFix: MachineHealthFixes["Service"]["autoFix"] = Effect.gen(function* () {
    const enabled = yield* settings.getSettings.pipe(
      Effect.map(({ health: { autoFix: on } }) => on),
      Effect.orElseSucceed(() => false),
    );
    if (!enabled) {
      yield* alertsState.setAutoFix(HealthAlertsState.EMPTY_AUTO_FIX_VIEW);
      return [];
    }
    const report = yield* health.report;
    const items = report.checks.flatMap((check) => check.items);
    const activeKeys = new Set(
      items.filter((item) => isAutoFixable(item, report.environmentId)).map((item) => item.key),
    );
    // Retain lifetime budgets for absent items, but publish only current problems.
    const viewOf = (state: HealthAutoFixState) =>
      healthAutoFixView(new Map([...state].filter(([key]) => activeKeys.has(key))));
    const plan = planHealthAutoFix(
      yield* readAutoFixState,
      items,
      report.environmentId,
      DateTime.toEpochMillis(yield* DateTime.now),
    );
    yield* saveAutoFixState(plan.state);
    // Held before the fixes run, so a slow one (an update) never alerts meanwhile.
    yield* alertsState.setAutoFix(viewOf(plan.state));
    let state = plan.state;
    const outcomes: Array<MachineHealthFixOutcome> = [];
    for (const item of plan.due) {
      const target = item.target;
      const outcome =
        item.fix === "update-machine" && target?._tag === "machine"
          ? yield* Effect.gen(function* () {
              const view = yield* machines.list;
              const targetVersion = newestMachineVersion(view.machines);
              if (targetVersion === undefined)
                return {
                  itemKey: item.key,
                  status: "failed",
                  message: "The target version is unknown.",
                } as const;
              const result = yield* machines
                .call(target.environmentId, MachineVersionAutoUpdate, { targetVersion })
                .pipe(Effect.timeout(PEER_FIX_TIMEOUT));
              return result.started
                ? ({
                    itemKey: item.key,
                    status: "fixed",
                    message: `Started updating to ${targetVersion}.`,
                  } as const)
                : ({
                    itemKey: item.key,
                    status: "deferred",
                    message: "Waiting for the machine to finish its work.",
                  } as const);
            }).pipe(
              Effect.catch(() =>
                Effect.succeed({
                  itemKey: item.key,
                  status: "failed",
                  message: "The machine update could not be started.",
                } as const),
              ),
            )
          : yield* runFix(item, true);
      if (outcome.status !== "deferred") outcomes.push(outcome);
      state = recordHealthAutoFix(state, item.key, outcome);
      if (outcome.status === "fixed" || outcome.status === "resolved")
        yield* Effect.logInfo("Machine health fixed a problem automatically", {
          itemKey: item.key,
          message: outcome.message,
        });
      else if (outcome.status !== "deferred")
        yield* Effect.logWarning("Machine health could not fix a problem automatically", {
          itemKey: item.key,
          message: outcome.message,
        });
    }
    yield* saveAutoFixState(state);
    yield* alertsState.setAutoFix(viewOf(state));
    return outcomes;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Automatic health fixes skipped: retry state unavailable", { error }).pipe(
        Effect.as([]),
      ),
    ),
    autoFixLock.withPermits(1),
    Effect.withSpan("MachineHealthFixes.autoFix"),
  );

  // The alerts' cadence: the scheduler ticks more often and this throttles it.
  const lastAutoFixAt = yield* Ref.make<number | null>(null);
  yield* scheduler.register(
    "health-auto-fix",
    Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const last = yield* Ref.get(lastAutoFixAt);
      if (last !== null && nowMs - last < Duration.toMillis(HEALTH_ALERT_EVALUATE_EVERY)) return;
      yield* Ref.set(lastAutoFixAt, nowMs);
      yield* autoFix;
    }),
  );

  return MachineHealthFixes.of({ fix, autoFix });
});

export const layer = Layer.effect(MachineHealthFixes, make);

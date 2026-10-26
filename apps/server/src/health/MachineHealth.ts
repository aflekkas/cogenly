// @effect-diagnostics nodeBuiltinImport:off -- Effect's FileSystem has no statfs; free disk space needs node:fs.
/**
 * MachineHealth: the state of each subsystem an always-on machine depends on,
 * as one report. The one service every transport calls (WebSocket RPC, MCP
 * `machine_health`, `cogenly health`). A paired machine's report is read over
 * the peer link; an unreachable one is described from what this side saw.
 *
 * Each check gathers its inputs concurrently under its own deadline and is
 * built by a pure function in healthChecks.ts. A source that fails or times
 * out makes its check `unknown`; it never fails the report. One loop
 * re-evaluates every 30 seconds for all subscribers, and remembers sync
 * backlogs between samples so a backlog that never drains reads as stuck.
 */
import * as NodeFSP from "node:fs/promises";

import {
  type EnvironmentId,
  type ChatSandboxSetupResult,
  MachineHealthError,
  type MachineHealthCheck,
  type MachineHealthCheckId,
  type MachineHealthInput,
  type MachineHealthItem,
  MachineHealthRead,
  type MachineHealthReport,
  type MachineHealthRetrySyncInput,
  type MachineInfo,
  type MachineListResult,
  type PeerCallError,
} from "@cogenly/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import packageJson from "../../package.json" with { type: "json" };
import * as ServiceLauncherClient from "../cloud/serviceLauncherClient.ts";
import * as ServerConfig from "../config.ts";
import * as Integrations from "../integrations/Integrations.ts";
import * as MachineIdentity from "../machines/MachineIdentity.ts";
import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ThreadReplication from "../threadSync/ThreadReplication.ts";
import * as SharedSync from "../sync/SharedSync.ts";
import * as MachineSetup from "../tailscale/MachineSetup.ts";
import * as TailscaleServeMode from "../tailscale/TailscaleServeMode.ts";
import * as ThreadSync from "../threadSync/ThreadSync.ts";
import * as ReadOnlySandbox from "../terminal/ReadOnlySandbox.ts";
import * as ChatGreetingService from "../greeting/ChatGreetingService.ts";
import * as HealthCanary from "./HealthCanary.ts";
import * as ComputerUseService from "../computerUse/ComputerUseService.ts";
import { readRateLimitStreaks } from "./rateLimitStreaks.ts";
import { readStaleRuns, readStuckQueues } from "./staleRuns.ts";
import * as AgentProcesses from "../process/AgentProcesses.ts";
import {
  type SyncPeerProgress,
  type SyncPeerSample,
  agentProcessesCheck,
  bootServiceCheck,
  computerUseCheck,
  chatSandboxCheck,
  buildReport,
  databaseCheck,
  directPeers,
  diskCheck,
  integrationsCheck,
  machineLinksCheck,
  providersCheck,
  rateLimitItems,
  sameReportContent,
  scheduledTasksCheck,
  serverCheck,
  stuckRunsCheck,
  stuckQueuesItems,
  syncCheck,
  tailscaleServeCheck,
  trackSyncProgress,
  unknownCheck,
} from "./healthChecks.ts";
import {
  peerReachabilityItem,
  peerReachabilityKey,
  unreachableReport,
} from "./peerReachability.ts";

export class MachineHealth extends Context.Service<
  MachineHealth,
  {
    /** This machine's report. Never fails: a check that cannot run is `unknown`. */
    readonly report: Effect.Effect<MachineHealthReport>;
    readonly setupSandbox: Effect.Effect<ChatSandboxSetupResult>;
    /** This machine, or a paired one read over the peer link. */
    readonly reportFor: (
      input: MachineHealthInput,
    ) => Effect.Effect<MachineHealthReport, MachineHealthError>;
    /** The report, then a fresh one whenever it changes. */
    readonly subscribe: (
      input: MachineHealthInput,
    ) => Stream.Stream<MachineHealthReport, MachineHealthError>;
    /** Retry held or failed sync with one paired machine now. */
    readonly retrySync: (
      input: MachineHealthRetrySyncInput,
    ) => Effect.Effect<void, MachineHealthError>;
  }
>()("cogenly-server/health/MachineHealth") {}

/** Each check's inputs must arrive within this, or the check reads `unknown`. */
const CHECK_TIMEOUT = Duration.seconds(5);
/** Statfs and the Tailscale probe are re-read at most this often. */
const SLOW_SOURCE_TTL = Duration.seconds(60);
/** How often the shared loop re-evaluates for subscribers. */
const EVALUATE_EVERY = Duration.seconds(30);
/** How long a paired machine has to answer with its report. */
const PEER_REPORT_TIMEOUT = Duration.seconds(15);
const RETRY_SYNC_TIMEOUT = Duration.seconds(60);

const unavailable = (cause?: unknown) =>
  new MachineHealthError({ reason: "unavailable", ...(cause === undefined ? {} : { cause }) });

/** Runs one check's gathering under its deadline; a failure is `unknown`, never the report's. */
const guarded = <E, R>(id: MachineHealthCheckId, effect: Effect.Effect<MachineHealthCheck, E, R>) =>
  effect.pipe(
    Effect.timeoutOption(CHECK_TIMEOUT),
    Effect.map(Option.getOrElse(() => unknownCheck(id, "Timed out"))),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("A machine health check could not run", { check: id, cause }).pipe(
            Effect.as(unknownCheck(id)),
          ),
    ),
  );

// ---------------------------------------------------------------------------
// Paired machines: serving this machine's report and reading theirs.
// ---------------------------------------------------------------------------

type PeerAnswer =
  | { readonly _tag: "report"; readonly report: MachineHealthReport }
  | { readonly _tag: "timeout" }
  | { readonly _tag: "error"; readonly reason: PeerCallError["reason"] };

/** The item for a machine the list shows online whose report still didn't arrive. */
function unansweredItem(machine: MachineInfo, answer: PeerAnswer): MachineHealthItem {
  const base = {
    key: peerReachabilityKey(machine.environmentId),
    since: null,
    target: { _tag: "machine", environmentId: machine.environmentId },
    fix: null,
  } as const;
  if (machine.relation === "peer") {
    return {
      ...base,
      status: "unknown",
      title: `${machine.name} is reached through the hub`,
      detail: "Its health can be read from the hub, or from a client connected to it.",
    };
  }
  if (answer._tag === "error" && answer.reason === "unknown-channel") {
    return {
      ...base,
      status: "unknown",
      title: `${machine.name} can't report its health`,
      detail: "It runs an older Cogenly. Update it to see its health here.",
    };
  }
  return {
    ...base,
    status: "warn",
    title: `${machine.name} didn't answer the health check`,
    detail: "It is connected, but its report didn't arrive. Try again shortly.",
  };
}

/**
 * Serves this machine's report on `MachineHealthRead` for the scope and reads
 * other machines'. Kept apart from the checks so tests can pair real machines
 * without the rest of the server.
 */
export const makePeerReports = Effect.fn("MachineHealth.makePeerReports")(function* (
  local: Effect.Effect<MachineHealthReport>,
) {
  const machines = yield* Machines.Machines;
  const channels = yield* PeerChannels.PeerChannels;
  const identity = yield* MachineIdentity.MachineIdentity;
  yield* channels.register(MachineHealthRead, () => local);

  const reportFor: MachineHealth["Service"]["reportFor"] = Effect.fn("MachineHealth.reportFor")(
    function* (input) {
      const self = yield* identity.self;
      const environmentId = input.environmentId;
      if (environmentId === undefined || environmentId === self.environmentId) return yield* local;
      const view = yield* machines.list.pipe(Effect.mapError(unavailable));
      const machine = view.machines.find(
        (candidate) => candidate.environmentId === environmentId && candidate.relation !== "this",
      );
      if (machine === undefined) return yield* new MachineHealthError({ reason: "not-paired" });
      const now = yield* DateTime.now;
      const offline = peerReachabilityItem({
        environmentId,
        name: machine.name,
        online: machine.online,
        lastSeenAt: machine.lastSeenAt,
        pairedAt: machine.pairedAt,
        pairing: machine.pairing,
        now,
      });
      if (offline !== null) {
        return unreachableReport({ environmentId, name: machine.name, item: offline, now });
      }
      // Only a direct hub–spoke link is callable; another spoke is the hub's to read.
      const answer: PeerAnswer =
        machine.relation === "peer"
          ? { _tag: "timeout" }
          : yield* machines.call(environmentId, MachineHealthRead, {}).pipe(
              Effect.timeoutOption(PEER_REPORT_TIMEOUT),
              Effect.map((report): PeerAnswer =>
                Option.isSome(report)
                  ? { _tag: "report", report: report.value }
                  : { _tag: "timeout" },
              ),
              Effect.catchTags({
                PeerCallError: (error) =>
                  Effect.succeed<PeerAnswer>({ _tag: "error", reason: error.reason }),
              }),
            );
      if (answer._tag === "report" && answer.report.environmentId === environmentId) {
        return answer.report;
      }
      return unreachableReport({
        environmentId,
        name: machine.name,
        item: unansweredItem(machine, answer),
        now: yield* DateTime.now,
      });
    },
  );

  return { reportFor };
});

// ---------------------------------------------------------------------------
// This machine's checks
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const identity = yield* MachineIdentity.MachineIdentity;
  const machines = yield* Machines.Machines;
  const sharedSync = yield* SharedSync.SharedSync;
  const threadSync = yield* ThreadSync.ThreadSync;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const integrations = yield* Integrations.Integrations;
  const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
  const setup = yield* MachineSetup.MachineSetup;
  const serveMode = yield* TailscaleServeMode.TailscaleServeMode;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const canary = yield* HealthCanary.HealthCanary;
  const greetings = yield* ChatGreetingService.ChatGreetingService;
  const computerUse = yield* ComputerUseService.ComputerUse;
  const sandbox = yield* ReadOnlySandbox.ReadOnlySandbox;
  const agentProcesses = yield* AgentProcesses.AgentProcesses;

  const freeSpace = yield* Effect.cachedWithTTL(
    Effect.tryPromise(() => NodeFSP.statfs(config.stateDir)).pipe(
      Effect.map((stats) => ({
        freeBytes: Number(stats.bavail) * Number(stats.bsize),
        totalBytes: Number(stats.blocks) * Number(stats.bsize),
      })),
    ),
    SLOW_SOURCE_TTL,
  );
  // The probe runs the tailscale CLI; read only while Serve is on. Only a
  // serving reading is kept for the TTL: one taken while Serve was still being
  // pointed at this run must not read as broken for the next minute.
  const servingSetup = yield* Effect.cachedWithTTL(setup.status, SLOW_SOURCE_TTL);
  const tailscaleSetup = servingSetup.pipe(
    Effect.flatMap((status) => (status.tailscale.served ? Effect.succeed(status) : setup.status)),
  );

  const database = Effect.all([
    sql<{ readonly page_count: number }>`PRAGMA page_count`,
    sql<{ readonly page_size: number }>`PRAGMA page_size`,
  ]).pipe(
    Effect.map(([count, size]) => {
      const pages = count[0]?.page_count;
      const pageSize = size[0]?.page_size;
      return databaseCheck({
        answered: true,
        sizeBytes: pages === undefined || pageSize === undefined ? null : pages * pageSize,
      });
    }),
    Effect.timeoutOption(CHECK_TIMEOUT),
    Effect.map(Option.getOrElse(() => databaseCheck({ answered: false, sizeBytes: null }))),
    // A database that errors is a failure, not an unknown.
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("The machine health database query failed", { cause }).pipe(
            Effect.as(databaseCheck({ answered: false, sizeBytes: null })),
          ),
    ),
  );

  /** Sync progress per peer, remembered between samples; in memory since this start. */
  const replication = yield* ThreadReplication.ThreadReplication;
  const syncProgress = new Map<EnvironmentId, SyncPeerProgress>();

  const sampleSync = (peers: ReadonlyArray<MachineInfo>, nowMs: number) =>
    Effect.gen(function* () {
      const latest = (yield* sql<{
        readonly shared: number;
        readonly events: number;
        readonly meta: number;
      }>`SELECT
          (SELECT COALESCE(MAX(cursor), 0) FROM shared_changes) AS shared,
          (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events) AS events,
          (SELECT COALESCE(MAX(seq), 0) FROM thread_replication_meta_log) AS meta`)[0];
      const samples = yield* Effect.forEach(peers, (peer) =>
        Effect.gen(function* () {
          const id = peer.environmentId;
          const row = (yield* sql<{
            readonly shared_ack: number | null;
            readonly events_ack: number | null;
            readonly meta_ack: number | null;
            readonly held_changes: number;
            readonly held_threads: number;
            readonly quarantined: number;
          }>`SELECT
              (SELECT acknowledged FROM shared_peer_cursors WHERE environment_id = ${id}) AS shared_ack,
              (SELECT acknowledged_events FROM thread_replication_cursors WHERE environment_id = ${id}) AS events_ack,
              (SELECT acknowledged_meta FROM thread_replication_cursors WHERE environment_id = ${id}) AS meta_ack,
              (SELECT COUNT(*) FROM shared_deferred_changes WHERE source_env = ${id})
                + (SELECT COUNT(*) FROM thread_replication_deferred WHERE source_env = ${id}) AS held_changes,
              (SELECT COUNT(DISTINCT thread_id) FROM thread_replication_deferred WHERE source_env = ${id}) AS held_threads,
              (SELECT COUNT(*) FROM thread_replication_deferred WHERE source_env = ${id} AND reason IS NOT NULL) AS quarantined`)[0];
          const sharedAck = row?.shared_ack ?? 0;
          const eventsAck = row?.events_ack ?? 0;
          const metaAck = row?.meta_ack ?? 0;
          const sample: SyncPeerSample = {
            environmentId: id,
            name: peer.name,
            online: peer.online,
            backlog:
              Math.max(0, (latest?.shared ?? 0) - sharedAck) +
              Math.max(0, (latest?.events ?? 0) - eventsAck) +
              Math.max(0, (latest?.meta ?? 0) - metaAck),
            acknowledged: `${sharedAck}:${eventsAck}:${metaAck}`,
            heldChanges: row?.held_changes ?? 0,
            heldThreads: row?.held_threads ?? 0,
            quarantined: row?.quarantined ?? 0,
          };
          const progress = trackSyncProgress(syncProgress.get(id), sample, nowMs);
          syncProgress.set(id, progress);
          return { sample, progress };
        }),
      );
      return syncCheck({ peers: samples, nowMs });
    });

  const activeRuns = (now: DateTime.Utc) =>
    Effect.gen(function* () {
      const active = yield* readStaleRuns(now);
      const queues = yield* readStuckQueues(now);
      const check = stuckRunsCheck({ active, now });
      if (queues.length === 0) return check;
      return {
        ...check,
        status: check.status === "fail" ? ("fail" as const) : ("warn" as const),
        summary: "Work needs attention",
        items: [...check.items, ...stuckQueuesItems(queues)],
      };
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  const evaluate: Effect.Effect<MachineHealthReport> = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const self = yield* identity.self;
    const view: Option.Option<MachineListResult> = yield* machines.list.pipe(
      Effect.timeoutOption(CHECK_TIMEOUT),
      Effect.option,
      Effect.map(Option.flatten),
    );
    const alwaysOn =
      self.role === "cloud-server" || (Option.isSome(view) && view.value.link._tag === "hub");
    const fromView = (
      id: MachineHealthCheckId,
      build: (view: MachineListResult) => Effect.Effect<MachineHealthCheck, unknown>,
    ) =>
      Option.isSome(view)
        ? guarded(id, build(view.value))
        : Effect.succeed(unknownCheck(id, "Paired machines couldn't be listed"));

    const checks = yield* Effect.all(
      [
        guarded(
          "server",
          Effect.map(Scheduler.lastSchedulerTickAtMs, (tickAt) =>
            serverCheck({
              version: packageJson.version,
              schedulerHeartbeatAgeMs: tickAt === null ? null : Math.max(0, nowMs - tickAt),
            }),
          ),
        ),
        Effect.sync(() => chatSandboxCheck(sandbox.status)),
        database,
        guarded("disk", Effect.map(freeSpace, diskCheck)),
        guarded(
          "providers",
          Effect.gen(function* () {
            const providerList = yield* providers.getProviders;
            const check = providersCheck({ providers: providerList, now });
            const items = yield* greetings.healthItems;
            const rateLimited = rateLimitItems({
              providers: providerList,
              streaks: yield* readRateLimitStreaks(now).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.catch(() => Effect.succeed([])),
              ),
            });
            const extra = [...items, ...rateLimited];
            return {
              ...check,
              status: check.status === "ok" && extra.length > 0 ? ("warn" as const) : check.status,
              summary:
                items.length > 0 ? `${check.summary} AI greetings keep failing.` : check.summary,
              items: [...check.items, ...extra],
            };
          }),
        ),
        fromView("machine-links", (list) =>
          Effect.succeed(machineLinksCheck({ machines: list.machines, link: list.link, now })),
        ),
        fromView("sync", (list) => sampleSync(directPeers(list.machines), nowMs)),
        guarded(
          "integrations",
          Effect.map(integrations.list(), (result) =>
            integrationsCheck({ integrations: result.integrations }),
          ),
        ),
        guarded(
          "scheduled-tasks",
          Effect.map(scheduledTasks.list(), (result) =>
            scheduledTasksCheck({
              // The canary has its own check.
              tasks: result.tasks.filter((task) => !HealthCanary.isHealthCanaryTaskId(task.id)),
              environmentId: self.environmentId,
              now,
            }),
          ),
        ),
        guarded("stuck-runs", activeRuns(now)),
        Effect.succeed(bootServiceCheck({ managed: launcher.managed, alwaysOn })),
        guarded(
          "tailscale-serve",
          Effect.gen(function* () {
            const mode = yield* serveMode.current;
            return tailscaleServeCheck({
              serveEnabled: mode.enabled,
              setup: mode.enabled ? yield* tailscaleSetup : null,
            });
          }),
        ),
        guarded("canary", canary.check),
        guarded("computer-use", Effect.map(computerUse.status(), computerUseCheck)),
        guarded("agent-processes", Effect.map(agentProcesses.snapshot, agentProcessesCheck)),
      ],
      { concurrency: "unbounded" },
    );
    return buildReport({
      environmentId: self.environmentId,
      machineName: self.name,
      observedAt: now,
      serverVersion: packageJson.version,
      uptimeSeconds: Math.floor(process.uptime()),
      checks,
    });
  }).pipe(Effect.withSpan("MachineHealth.evaluate"));

  // The newest report whose content changed; subscribers share it.
  const latest = yield* SubscriptionRef.make<MachineHealthReport | null>(null);
  const publish = (next: MachineHealthReport) =>
    SubscriptionRef.get(latest).pipe(
      Effect.flatMap((current) =>
        current !== null && sameReportContent(current, next)
          ? Effect.void
          : SubscriptionRef.set(latest, next),
      ),
    );
  const report: MachineHealth["Service"]["report"] = evaluate.pipe(Effect.tap(publish));
  yield* forkParked(Effect.forever(report.pipe(Effect.andThen(Effect.sleep(EVALUATE_EVERY)))));

  const { reportFor } = yield* makePeerReports(report);

  const subscribe: MachineHealth["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      identity.self.pipe(
        Effect.map((self): Stream.Stream<MachineHealthReport, MachineHealthError> =>
          input.environmentId === undefined || input.environmentId === self.environmentId
            ? Stream.fromEffect(report).pipe(
                Stream.concat(
                  SubscriptionRef.changes(latest).pipe(
                    Stream.filter((next): next is MachineHealthReport => next !== null),
                  ),
                ),
              )
            : Stream.tick(EVALUATE_EVERY).pipe(Stream.mapEffect(() => reportFor(input))),
        ),
      ),
    ).pipe(Stream.changesWith(sameReportContent));

  const retrySync: MachineHealth["Service"]["retrySync"] = Effect.fn("MachineHealth.retrySync")(
    function* (input) {
      const view = yield* machines.list.pipe(Effect.mapError(unavailable));
      const peer = directPeers(view.machines).find(
        (machine) => machine.environmentId === input.environmentId,
      );
      if (peer === undefined) return yield* new MachineHealthError({ reason: "not-paired" });
      yield* replication.replayHeld;
      if (!peer.online) return yield* unavailable();
      yield* Effect.all(
        [sharedSync.sync(peer.environmentId), threadSync.sync(peer.environmentId)],
        {
          concurrency: "unbounded",
          discard: true,
        },
      ).pipe(Effect.timeout(RETRY_SYNC_TIMEOUT), Effect.mapError(unavailable));
    },
  );

  return MachineHealth.of({
    report,
    reportFor,
    subscribe,
    retrySync,
    setupSandbox: sandbox.setup.pipe(Effect.tap(() => report)),
  });
});

export const layer = Layer.effect(MachineHealth, make).pipe(Layer.provide(ReadOnlySandbox.layer));

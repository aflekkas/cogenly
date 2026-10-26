import {
  CommandId,
  isProviderAvailable,
  isProviderTextGenerationCapable,
  type MachineHealthCanarySettings,
  type MachineHealthCheck,
  type MachineHealthItem,
  type ModelSelection,
  type OrchestrationV2Run,
  type ScheduledTask,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  type ServerProvider,
  type ServerSettings as ServerSettingsDocument,
  ThreadId,
} from "@cogenly/contracts";
import { defaultTextGenerationModelForDriver } from "@cogenly/provider-core/server/driver";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";

/**
 * The opt-in health canary: one scheduled task per machine that runs a tiny
 * turn on the cheapest model, proving providers, orchestration and
 * scheduling work end to end. `settings.health.canary` on the owner is the
 * source of truth; this service reconciles it into the task and reads the
 * latest run's real turn outcome for the `canary` health check.
 *
 * Task ids are `health-canary:<environmentId>:<uuid>`. The environment id
 * keeps paired machines apart (each only ever touches its own prefix, and
 * the replicated copy never runs on the peer because its `ownerMachine` is
 * the owner). The uuid is there because a deleted schedule leaves a sync
 * tombstone, so turning the canary back on needs a fresh id.
 */

const TASK_ID_PREFIX = "health-canary:";
const CANARY_TITLE = "Health canary";
const CANARY_PROMPT = "Reply with exactly OK.";
/** One fixed folder under Scratch, so runs never create a worktree or a folder each. */
const CANARY_FOLDER = ".health-canary";
const RUN_DEADLINE_MS = 10 * 60_000;
/** A missing success older than this many intervals fails the check. */
const STALE_INTERVALS = 2.5;
const RUN_KEY = "canary:run";
const EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["reasoningEffort", "effort"]);

/** True for any machine's canary task id, so the scheduled-tasks check skips it. */
export const isHealthCanaryTaskId = (id: string): boolean => id.startsWith(TASK_ID_PREFIX);

export class HealthCanary extends Context.Service<
  HealthCanary,
  {
    /** The `canary` check. Never fails: a canary that cannot be read is `unknown`. */
    readonly check: Effect.Effect<MachineHealthCheck>;
  }
>()("cogenly-server/health/HealthCanary") {}

// ---------------------------------------------------------------------------
// Pure parts: the model choice and the outcome classification.
// ---------------------------------------------------------------------------

const isUsableProvider = (provider: ServerProvider): boolean =>
  provider.enabled &&
  provider.installed &&
  isProviderAvailable(provider) &&
  isProviderTextGenerationCapable(provider) &&
  provider.status !== "error" &&
  provider.status !== "disabled" &&
  provider.auth.status !== "unauthenticated";

/**
 * The canary's model: the machine's text generation selection (already the
 * driver's cheap default on an enabled instance), or, when the provider
 * snapshot shows that instance can't run, the first usable instance's cheap
 * default. Reasoning effort is set to `low` when the model offers it.
 */
function canaryModelSelection(
  settings: Pick<ServerSettingsDocument, "textGenerationModelSelection">,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const preferred = settings.textGenerationModelSelection;
  const preferredProvider = providers.find(
    (provider) => provider.instanceId === preferred.instanceId,
  );
  const fallbackProvider =
    preferredProvider === undefined || isUsableProvider(preferredProvider)
      ? undefined
      : providers.find(isUsableProvider);
  const fallbackModel =
    fallbackProvider === undefined
      ? undefined
      : (defaultTextGenerationModelForDriver(BUILT_IN_DRIVERS, fallbackProvider.driver) ??
        fallbackProvider.models.find((model) => model.isDefault === true)?.slug ??
        fallbackProvider.models[0]?.slug);
  const useFallback = fallbackProvider !== undefined && fallbackModel !== undefined;
  const provider = useFallback ? fallbackProvider : preferredProvider;
  const instanceId = useFallback ? fallbackProvider.instanceId : preferred.instanceId;
  const model = useFallback ? fallbackModel : preferred.model;
  const effort = provider?.models
    .find((candidate) => candidate.slug === model)
    ?.capabilities?.optionDescriptors?.find(
      (descriptor) =>
        descriptor.type === "select" &&
        EFFORT_OPTION_IDS.has(descriptor.id) &&
        descriptor.options.some((choice) => choice.id === "low"),
    );
  return effort === undefined
    ? { instanceId, model }
    : { instanceId, model, options: [{ id: effort.id, value: "low" }] };
}

/** The latest canary run's turn, read from the thread projection. */
export interface CanaryRunObservation {
  readonly threadId: ThreadId;
  readonly status: OrchestrationV2Run["status"];
  readonly requestedAt: DateTime.Utc;
  readonly completedAt: DateTime.Utc | null;
  /** A finished, non-empty assistant message belongs to the run. */
  readonly replied: boolean;
}

export interface CanaryObservation {
  readonly settings: MachineHealthCanarySettings;
  readonly task: Pick<
    ScheduledTask,
    "id" | "enabled" | "createdAt" | "lastRunAt" | "lastRunStatus"
  > | null;
  readonly run: CanaryRunObservation | null;
  /** Why reconciling could not produce the scheduled task. */
  readonly scheduleProblem: "scratch-unavailable" | "failed" | null;
  readonly now: DateTime.Utc;
}

const isoMillis = (iso: string | null): number | null =>
  iso === null
    ? null
    : Option.match(DateTime.make(iso), { onNone: () => null, onSome: DateTime.toEpochMillis });

const formatDuration = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${Math.round(minutes / 60)} hours`;
};

function canaryItem(input: {
  readonly status: MachineHealthItem["status"];
  readonly title: string;
  readonly detail: string;
  readonly sinceMs: number | null;
  readonly target: MachineHealthItem["target"];
  readonly fix: MachineHealthItem["fix"];
}): MachineHealthItem {
  return {
    key: RUN_KEY,
    status: input.status,
    title: input.title,
    detail: input.detail,
    since: input.sinceMs === null ? null : DateTime.makeUnsafe(input.sinceMs),
    target: input.target,
    fix: input.fix,
  };
}

function classifyItem(
  observation: CanaryObservation & { readonly task: NonNullable<CanaryObservation["task"]> },
): MachineHealthItem {
  const { task, run } = observation;
  const nowMs = DateTime.toEpochMillis(observation.now);
  const staleMs = observation.settings.intervalMinutes * 60_000 * STALE_INTERVALS;
  const taskTarget = { _tag: "scheduledTask" as const, taskId: task.id };
  const failed = (title: string, detail: string, sinceMs: number | null) =>
    canaryItem({ status: "fail", title, detail, sinceMs, target: taskTarget, fix: "run-now" });

  if (!task.enabled) {
    return canaryItem({
      status: "warn",
      title: "Canary is paused",
      detail:
        "Its scheduled task was turned off. Saving the canary settings or restarting this machine turns it back on.",
      sinceMs: null,
      target: taskTarget,
      fix: null,
    });
  }
  // A failed dispatch leaves no run newer than the attempt.
  const lastRunAtMs = isoMillis(task.lastRunAt);
  if (
    task.lastRunStatus === "failed" &&
    lastRunAtMs !== null &&
    (run === null || DateTime.toEpochMillis(run.requestedAt) < lastRunAtMs)
  ) {
    return failed(
      "Canary couldn't start a turn",
      "The last scheduled run failed before reaching the provider.",
      lastRunAtMs,
    );
  }
  if (run === null) {
    if (task.lastRunStatus === "running") {
      return canaryItem({
        status: "ok",
        title: "Canary run in progress",
        detail: "Starting the canary turn.",
        sinceMs: null,
        target: taskTarget,
        fix: null,
      });
    }
    const createdAtMs = isoMillis(task.createdAt) ?? nowMs;
    return nowMs - createdAtMs > staleMs
      ? failed(
          "Canary hasn't run",
          `No canary run in ${formatDuration(nowMs - createdAtMs)}.`,
          createdAtMs + staleMs,
        )
      : canaryItem({
          status: "ok",
          title: "Canary scheduled",
          detail: "The first run hasn't happened yet.",
          sinceMs: null,
          target: taskTarget,
          fix: null,
        });
  }

  const threadTarget = { _tag: "thread" as const, threadId: run.threadId };
  const requestedAtMs = DateTime.toEpochMillis(run.requestedAt);
  const completedAtMs = run.completedAt === null ? null : DateTime.toEpochMillis(run.completedAt);
  switch (run.status) {
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return nowMs - requestedAtMs > RUN_DEADLINE_MS
        ? canaryItem({
            status: "fail",
            title: "Canary turn missed its deadline",
            detail: "The last run hasn't finished after 10 minutes.",
            sinceMs: requestedAtMs + RUN_DEADLINE_MS,
            target: threadTarget,
            fix: "stop-runs",
          })
        : canaryItem({
            status: "ok",
            title: "Canary run in progress",
            detail: "Waiting for the provider to reply.",
            sinceMs: null,
            target: threadTarget,
            fix: null,
          });
    case "failed":
      return failed(
        "Canary turn failed",
        "The provider did not complete the last run.",
        completedAtMs ?? requestedAtMs,
      );
    case "interrupted":
      return failed(
        "Canary turn was interrupted",
        "The last run stopped before it finished.",
        completedAtMs ?? requestedAtMs,
      );
    case "cancelled":
    case "rolled_back":
      return failed(
        "Canary turn was cancelled",
        "The last run was cancelled before it finished.",
        completedAtMs ?? requestedAtMs,
      );
    case "completed": {
      const finishedAtMs = completedAtMs ?? requestedAtMs;
      if (!run.replied) {
        return failed(
          "Canary turn ended without a reply",
          "The provider finished the last run without answering.",
          finishedAtMs,
        );
      }
      if (finishedAtMs - requestedAtMs > RUN_DEADLINE_MS) {
        return failed(
          "Canary turn was too slow",
          `The last run took ${formatDuration(finishedAtMs - requestedAtMs)}, over the 10-minute deadline.`,
          finishedAtMs,
        );
      }
      if (nowMs - finishedAtMs > staleMs) {
        return failed(
          "Canary hasn't passed recently",
          `No successful canary run in ${formatDuration(nowMs - finishedAtMs)}.`,
          finishedAtMs + staleMs,
        );
      }
      return canaryItem({
        status: "ok",
        title: "Canary passed",
        detail: "The last run got a reply from the provider in time.",
        sinceMs: finishedAtMs,
        target: threadTarget,
        fix: null,
      });
    }
  }
}

/** The `canary` check from what was gathered; no I/O. */
export function classifyCanary(observation: CanaryObservation): MachineHealthCheck {
  if (!observation.settings.enabled) {
    return { id: "canary", status: "ok", summary: "Canary off", items: [] };
  }
  const { task } = observation;
  const item =
    task === null
      ? canaryItem({
          status: "warn",
          title:
            observation.scheduleProblem === "scratch-unavailable"
              ? "Canary can't be scheduled"
              : "Canary isn't scheduled",
          detail:
            observation.scheduleProblem === "scratch-unavailable"
              ? "This machine has no folder for chats without a project, which the canary runs in."
              : observation.scheduleProblem === "failed"
                ? "Setting up the canary's scheduled task failed. The server log has details."
                : "The canary's scheduled task is being set up.",
          sinceMs: null,
          target: null,
          fix: null,
        })
      : classifyItem({ ...observation, task });
  return { id: "canary", status: item.status, summary: item.title, items: [item] };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const unreadableCheck: MachineHealthCheck = {
  id: "canary",
  status: "unknown",
  summary: "Canary result could not be read",
  items: [],
};

/** Settings that change the task; other settings changes skip reconciling. */
const reconcileKey = (settings: ServerSettingsDocument): string =>
  JSON.stringify([settings.health.canary, settings.textGenerationModelSelection]);

const sameModelSelection = (left: ModelSelection, right: ModelSelection): boolean =>
  left.instanceId === right.instanceId &&
  left.model === right.model &&
  JSON.stringify(left.options ?? []) === JSON.stringify(right.options ?? []);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* ScheduledTasks.ScheduledTaskService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const environmentId = yield* identity.getEnvironmentId;
  const ownPrefix = `${TASK_ID_PREFIX}${environmentId}:`;
  const scheduleProblem = yield* Ref.make<CanaryObservation["scheduleProblem"]>(null);
  const lastReconciledKey = yield* Ref.make<string | null>(null);

  /** This machine's canary tasks, newest first. Other machines' are never touched. */
  const ownTasks = tasks
    .list()
    .pipe(
      Effect.map(({ tasks: all }) =>
        all
          .filter((task) => task.id.startsWith(ownPrefix))
          .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt)),
      ),
    );

  const reconcile = Effect.fn("HealthCanary.reconcile")(function* (
    settings: ServerSettingsDocument,
  ) {
    const { enabled, intervalMinutes } = settings.health.canary;
    const [current, ...extra] = yield* ownTasks;
    for (const task of enabled ? extra : [current, ...extra]) {
      if (task !== undefined) yield* tasks.delete({ id: task.id });
    }
    if (!enabled) {
      yield* Ref.set(scheduleProblem, null);
      return;
    }
    const root = yield* folders.scratchRoot;
    if (Option.isNone(root)) {
      yield* Ref.set(scheduleProblem, "scratch-unavailable");
      return;
    }
    const { projectId } = yield* folders.ensureScratchProject;
    const worktreePath = path.join(root.value, CANARY_FOLDER);
    yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
    const modelSelection = canaryModelSelection(settings, yield* providers.getProviders);
    const everyMs = intervalMinutes * 60_000;
    yield* Ref.set(scheduleProblem, null);
    if (
      current !== undefined &&
      current.ownerMachine === environmentId &&
      current.agentId == null &&
      current.title === CANARY_TITLE &&
      current.prompt === CANARY_PROMPT &&
      current.enabled &&
      current.schedule.type === "interval" &&
      current.schedule.everyMs === everyMs &&
      current.projectId === projectId &&
      current.threadId === null &&
      current.workspaceStrategy.type === "existing_worktree" &&
      current.workspaceStrategy.worktreePath === worktreePath &&
      current.interactionMode === "default" &&
      sameModelSelection(current.modelSelection, modelSelection)
    ) {
      return;
    }
    const id = current?.id ?? ScheduledTaskId.make(`${ownPrefix}${yield* crypto.randomUUIDv4()}`);
    const input: ScheduledTaskUpsertInput = {
      id,
      ownerMachine: environmentId,
      title: CANARY_TITLE,
      prompt: CANARY_PROMPT,
      enabled: true,
      schedule: { type: "interval", everyMs },
      projectId,
      // A null thread launches a fresh thread per run.
      threadId: null,
      workspaceStrategy: { type: "existing_worktree", worktreePath },
      modelSelection,
      // Runtime mode is always full access. Default interaction mode: plan
      // mode is ignored by Claude and, on Codex, adds a long prompt and may
      // stop to ask a question, which would read as a canary failure.
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "system",
      creationSource: "server",
    };
    yield* tasks.upsert(input);
  });

  const reconcileIfChanged = (settings: ServerSettingsDocument) =>
    Effect.gen(function* () {
      const key = reconcileKey(settings);
      if (key === (yield* Ref.get(lastReconciledKey))) return;
      const reconciled = yield* reconcile(settings).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Could not reconcile the health canary task", { cause }).pipe(
                Effect.andThen(Ref.set(scheduleProblem, "failed")),
                Effect.as(false),
              ),
        ),
      );
      yield* Ref.set(lastReconciledKey, reconciled ? key : null);
    });

  // Subscribe before the startup read so no change between the two is lost.
  const changes = yield* serverSettings.subscribeChanges;
  yield* forkParked(
    serverSettings.getSettings.pipe(
      Effect.flatMap(reconcileIfChanged),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Could not read settings for the health canary", { cause }),
      ),
      Effect.andThen(Stream.runForEach(changes, reconcileIfChanged)),
    ),
  );

  /**
   * The task's latest run. ScheduledTaskService ids a scheduled message
   * `scheduled-task-message:<taskId>:<fire key>`, so a primary-key range
   * finds it without scanning every message.
   */
  const latestRun = Effect.fn("HealthCanary.latestRun")(function* (taskId: ScheduledTaskId) {
    const prefix = `scheduled-task-message:${taskId}:`;
    const upperBound = `${prefix.slice(0, -1)};`;
    const rows = yield* sql<{ readonly message_id: string; readonly thread_id: string }>`
      SELECT message_id, thread_id
      FROM orchestration_v2_projection_messages
      WHERE message_id >= ${prefix} AND message_id < ${upperBound}
      ORDER BY created_at DESC, message_id DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const threadId = ThreadId.make(row.thread_id);
    const records = yield* threads.getThreadRecords(threadId, ["runs", "messages"], {
      messageRoles: ["assistant"],
    });
    const run = records.runs.find((candidate) => candidate.userMessageId === row.message_id);
    if (run === undefined) return null;
    const observation: CanaryRunObservation = {
      threadId,
      status: run.status,
      requestedAt: run.requestedAt,
      completedAt: run.completedAt,
      replied: records.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.runId === run.id &&
          !message.streaming &&
          message.text.trim().length > 0,
      ),
    };
    return { observation, archived: records.thread.archivedAt !== null };
  });

  const check: HealthCanary["Service"]["check"] = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    const now = yield* DateTime.now;
    if (!settings.health.canary.enabled) {
      return classifyCanary({
        settings: settings.health.canary,
        task: null,
        run: null,
        scheduleProblem: null,
        now,
      });
    }
    const [task] = yield* ownTasks;
    const latest = task === undefined ? null : yield* latestRun(task.id);
    // A passed run's thread is archived so canary threads don't pile up in
    // the sidebar; failed ones stay put for the owner to open. The command
    // id makes this once per thread, so a thread the user unarchives stays.
    if (
      latest !== null &&
      !latest.archived &&
      latest.observation.status === "completed" &&
      latest.observation.replied
    ) {
      yield* threads
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`health-canary:archive:${latest.observation.threadId}`),
          threadId: latest.observation.threadId,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not archive a passed health canary thread", { cause }),
          ),
        );
    }
    return classifyCanary({
      settings: settings.health.canary,
      task: task ?? null,
      run: latest?.observation ?? null,
      scheduleProblem: yield* Ref.get(scheduleProblem),
      now,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Could not read the health canary", { cause }).pipe(
            Effect.as(unreadableCheck),
          ),
    ),
  );

  return HealthCanary.of({ check });
});

export const layer = Layer.effect(HealthCanary, make);

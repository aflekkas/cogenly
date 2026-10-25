// @effect-diagnostics nodeBuiltinImport:off
/**
 * Import from T3 Code, as a server service: detects the local T3 install,
 * runs dry-run scans and imports as background jobs, and publishes their state.
 *
 * T3 Code may stay open. A scan copies T3's database into a temp snapshot
 * (see `T3SourceDatabase.ts`) and the confirmed import replays that same
 * snapshot, so the report and the import agree; T3 changes made after the
 * scan come over on the next run. The snapshot is deleted when the import
 * ends, a new scan starts, or the service stops.
 *
 * An import is: back up Cogenly's database, add the provider instances the
 * threads were run with (so they resume against the same Claude/Codex homes),
 * optionally bring over preferences, map or create projects by folder, replay
 * thread events through the event sink, then copy attachments. See
 * `T3ImportEngine.ts` for the event path and its idempotency.
 *
 * @module T3ImportService
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  CommandId,
  KeybindingRule,
  ProjectId,
  type T3ImportJob,
  type T3ImportProgress,
  type T3ImportProjectReport,
  type T3ImportReport,
  type T3ImportResult,
  type T3ImportRunInput,
  type T3ImportScanInput,
  type T3ImportScope,
  type T3ImportSource,
  type T3ImportSourceProject,
  type T3ImportStatus,
  T3ImportError,
  T3_IMPORT_RUNNING_NOTE,
  T3_IMPORT_STATUS_HEARTBEAT_MS,
} from "@cogenly/contracts";
import { normalizeProjectPathForComparison } from "@cogenly/shared/path";
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Keybindings from "../keybindings.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { backupDatabase } from "../persistence/DatabaseBackup.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { T3_IMPORT_COMMAND_PREFIX } from "./T3ImportCommandIds.ts";
import {
  classifyThreads,
  mappingContext,
  replayEvents,
  type T3EventSummary,
  type T3ThreadPlan,
} from "./T3ImportEngine.ts";
import {
  planPreferences,
  planProviderInstances,
  type T3PreferencesPlan,
  type T3ProviderPlan,
} from "./T3SettingsPlan.ts";
import {
  checkT3SnapshotSpace,
  defaultT3SnapshotRoot,
  openT3SourceDatabase,
  removeT3SourceSnapshot,
  snapshotT3SourceDatabase,
  type T3SourceDatabase,
  type T3SourceProjectRow,
  type T3SnapshotProgress,
  type T3SourceSnapshot,
} from "./T3SourceDatabase.ts";

export interface T3ImportServiceOptions {
  /** T3 Code's userdata directory; defaults to `~/.t3/userdata`. */
  readonly sourceDir?: string;
  /** Where snapshots of T3's database go; defaults to the OS temp directory. */
  readonly snapshotRoot?: string;
  /** Free bytes under a directory; tests pin it to exercise the space check. */
  readonly freeBytes?: (directory: string) => number;
}

export class T3ImportService extends Context.Service<
  T3ImportService,
  {
    readonly status: Stream.Stream<T3ImportStatus>;
    readonly scan: (
      input: T3ImportScanInput,
    ) => Effect.Effect<{ readonly started: boolean }, T3ImportError>;
    readonly run: (
      input: T3ImportRunInput,
    ) => Effect.Effect<{ readonly started: boolean }, T3ImportError>;
    readonly cancel: Effect.Effect<{ readonly cancelled: boolean }>;
  }
>()("cogenly-server/t3Import/T3ImportService") {}

const SOURCE_POLL_INTERVAL = "3 seconds";

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Whether T3 Code's server is running, from the runtime file it writes while up. */
export function isT3ServerRunning(sourceDir: string): boolean {
  const state = readJsonFile(NodePath.join(sourceDir, "server-runtime.json"));
  const pid =
    typeof state === "object" && state !== null ? (state as { pid?: unknown }).pid : undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

interface CogenlyProjectRow {
  readonly project_id: string;
  readonly title: string;
  readonly workspace_root: string;
}

interface ProjectTarget {
  readonly source: T3SourceProjectRow;
  readonly action: "merge" | "create";
  readonly projectId: ProjectId;
  readonly title: string;
  /** T3 Code's no-project folder, or a chat folder under it: filed under Cogenly's "No project". */
  readonly scratch: boolean;
}

/** Stands in for "No project" in a scan made before Cogenly has created it; the import creates it. */
const NO_PROJECT_PENDING_ID = ProjectId.make("t3-import:no-project");

interface ImportPlan {
  readonly report: T3ImportReport;
  readonly targets: ReadonlyArray<ProjectTarget>;
  readonly threads: ReadonlyArray<T3ThreadPlan>;
  readonly providers: T3ProviderPlan;
  readonly preferences: T3PreferencesPlan;
  readonly summary: T3EventSummary;
  readonly attachments: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    readonly bytes: number;
  }>;
}

function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.slice(0, 200) ?? "unknown error";
}

const decodeKeybindings = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));
const decodeRule = Schema.decodeUnknownOption(KeybindingRule);

/**
 * The status a subscriber sees: `current` sampled on each trigger, sent when
 * it changed, and re-sent at least every `T3_IMPORT_STATUS_HEARTBEAT_MS`
 * while a scan or import runs. A long snapshot or replay can go minutes
 * without a visible change; the heartbeat lets a follower (the CLI) tell
 * that apart from a dead stream. Idle states stay quiet.
 */
export const withStatusHeartbeat = <E, R>(
  triggers: Stream.Stream<void, E, R>,
  current: Effect.Effect<T3ImportStatus>,
): Stream.Stream<T3ImportStatus, E, R> =>
  Stream.suspend(() => {
    let lastSent = "";
    const shouldSend = (status: T3ImportStatus, beat: boolean) => {
      const encoded = JSON.stringify(status);
      const active = status.job._tag === "Scanning" || status.job._tag === "Importing";
      if (encoded === lastSent && !(beat && active)) return false;
      lastSent = encoded;
      return true;
    };
    return Stream.merge(
      triggers.pipe(Stream.as(false)),
      // The first tick is immediate; heartbeats proper follow it.
      Stream.tick(Duration.millis(T3_IMPORT_STATUS_HEARTBEAT_MS)).pipe(Stream.as(true)),
    ).pipe(
      Stream.mapEffect((beat) => current.pipe(Effect.map((status) => ({ status, beat })))),
      Stream.filter(({ status, beat }) => shouldSend(status, beat)),
      Stream.map(({ status }) => status),
    );
  });

const make = (options: T3ImportServiceOptions = {}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const sql = yield* SqlClient.SqlClient;
    const eventSink = yield* EventSink.EventSinkV2;
    const projects = yield* ProjectService.ProjectService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const keybindings = yield* Keybindings.Keybindings;
    const home = yield* HostProcess.HomeDirectory;
    const serviceScope = yield* Effect.scope;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    /** Engine steps read the database through the service's own client. */
    const withDeps = <A, E>(
      effect: Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem | Path.Path>,
    ) =>
      effect.pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      );
    const sourceDir = options.sourceDir ?? NodePath.join(home, ".t3", "userdata");
    const sourceDbPath = NodePath.join(sourceDir, "statev2.sqlite");
    const sourceAttachmentsDir = NodePath.join(sourceDir, "attachments");
    const snapshotRoot = options.snapshotRoot ?? defaultT3SnapshotRoot();
    const scratchRoot = normalizeProjectPathForComparison(NodePath.join(home, ".t3", "scratch"));
    /** T3 Code's no-project folder, or a per-chat folder it made under it. */
    const isT3Scratch = (workspaceRoot: string) => {
      const key = normalizeProjectPathForComparison(workspaceRoot);
      return (
        key === scratchRoot ||
        key.startsWith(`${scratchRoot}/`) ||
        key.startsWith(`${scratchRoot}\\`)
      );
    };
    // Present in the running server; the offline CLI has no Scratch to file into.
    const managedFolders = yield* Effect.serviceOption(ManagedProjectFolders.ManagedProjectFolders);

    const job = yield* SubscriptionRef.make<T3ImportJob>({ _tag: "Idle" });
    const latest = yield* Ref.make<{
      readonly reportId: string;
      readonly scope: T3ImportScope;
    } | null>(null);
    /** The snapshot the latest scan read; the confirmed import replays it. */
    const heldSnapshot = yield* Ref.make<T3SourceSnapshot | null>(null);
    const cancelRequested = yield* Ref.make(false);
    const running = yield* Ref.make<Fiber.Fiber<unknown, unknown> | null>(null);

    const failed = (reason: T3ImportError["reason"], detail: string) =>
      new T3ImportError({ reason, detail });

    const withSource = <A, E, R>(
      dbPath: string,
      live: boolean,
      use: (source: T3SourceDatabase) => Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        Effect.try({
          try: () => openT3SourceDatabase(dbPath, { live }),
          catch: (cause) =>
            failed("source-unavailable", cause instanceof Error ? cause.message : String(cause)),
        }),
        use,
        (source) => Effect.sync(() => source.close()),
      );

    const dropSnapshot = Ref.getAndSet(heldSnapshot, null).pipe(
      Effect.flatMap((snapshot) =>
        snapshot === null ? Effect.void : Effect.sync(() => removeT3SourceSnapshot(snapshot)),
      ),
    );
    yield* Effect.addFinalizer(() => dropSnapshot);

    const setProgress = (progress: T3ImportProgress) =>
      SubscriptionRef.update(job, (current) =>
        current._tag === "Scanning"
          ? { _tag: "Scanning" as const, progress }
          : current._tag === "Importing"
            ? { ...current, progress }
            : current,
      );

    /** Copy T3's live database into a temp snapshot, after checking there is room for it. */
    const takeSnapshot = Effect.fn("T3Import.takeSnapshot")(function* () {
      yield* dropSnapshot;
      if (!NodeFS.existsSync(sourceDbPath)) {
        return yield* failed("source-unavailable", `No T3 Code database at ${sourceDbPath}.`);
      }
      const space = checkT3SnapshotSpace({
        dbPath: sourceDbPath,
        tempRoot: snapshotRoot,
        ...(options.freeBytes === undefined ? {} : { freeBytes: options.freeBytes }),
      });
      if (!space.enough) {
        return yield* failed(
          "insufficient-space",
          `Copying T3 Code's data needs ${formatGigabytes(space.requiredBytes)} free in ${snapshotRoot}, but only ${formatGigabytes(space.availableBytes)} is free. Free up space and try again.`,
        );
      }
      // Progress arrives from Node's backup callback, between copy steps.
      const runFork = Effect.runForkWith(yield* Effect.context<never>());
      let lastPercent = -1;
      const onProgress = ({ copiedBytes, totalBytes }: T3SnapshotProgress) => {
        const percent = totalBytes > 0 ? Math.floor((copiedBytes / totalBytes) * 100) : 0;
        if (percent === lastPercent) return;
        lastPercent = percent;
        runFork(
          setProgress({
            phase: "snapshot",
            processedEvents: 0,
            totalEvents: 0,
            copiedBytes,
            totalBytes,
          }),
        );
      };
      // A backup cannot be stopped halfway; let it finish, then clean up.
      const snapshot = yield* Effect.tryPromise({
        try: () =>
          snapshotT3SourceDatabase({ dbPath: sourceDbPath, tempRoot: snapshotRoot, onProgress }),
        catch: (cause) =>
          failed("source-unavailable", `Couldn't copy T3 Code's data: ${errorSummary(cause)}`),
      }).pipe(Effect.uninterruptible);
      yield* Ref.set(heldSnapshot, snapshot);
      return snapshot;
    });

    const cogenlyProjects = sql<CogenlyProjectRow>`
      SELECT project_id, title, workspace_root FROM projection_projects WHERE deleted_at IS NULL
    `;

    const findByRoot = (rows: ReadonlyArray<CogenlyProjectRow>, root: string) => {
      const key = normalizeProjectPathForComparison(root);
      return rows.find((row) => normalizeProjectPathForComparison(row.workspace_root) === key);
    };

    const detectSource = Effect.fn("T3Import.detectSource")(function* () {
      const base = {
        databasePath: sourceDbPath,
        running: isT3ServerRunning(sourceDir),
        backupDirectory: NodePath.join(config.baseDir, "backups"),
      };
      const rows = yield* cogenlyProjects.pipe(Effect.orElseSucceed(() => []));
      const listed = yield* withSource(sourceDbPath, true, (source) =>
        Effect.sync(() => {
          const counts = source.projectThreadCounts();
          return source.listProjects().map((project): T3ImportSourceProject => {
            const count = counts.get(project.projectId) ?? { threads: 0, roots: 0 };
            const existing = findByRoot(rows, project.workspaceRoot);
            const isScratch = isT3Scratch(project.workspaceRoot);
            return {
              sourceProjectId: project.projectId,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              threadCount: count.threads,
              rootThreadCount: count.roots,
              existingProjectId:
                existing === undefined ? null : ProjectId.make(existing.project_id),
              existingProjectTitle: existing?.title ?? null,
              isScratch,
              selectedByDefault: !isScratch && count.threads > 0,
            };
          });
        }),
      ).pipe(Effect.result);
      return listed._tag === "Success"
        ? ({ ...base, available: true, projects: listed.success } satisfies T3ImportSource)
        : ({
            ...base,
            available: false,
            projects: [],
            error: listed.failure.detail,
          } satisfies T3ImportSource);
    });

    const resolveScope = (scope: T3ImportScope, available: ReadonlyArray<T3ImportSourceProject>) =>
      scope.sourceProjectIds.length > 0
        ? scope.sourceProjectIds
        : available
            .filter((project) => project.selectedByDefault)
            .map((project) => project.sourceProjectId);

    /** Everything an import would do, from a fresh read of both databases. Writes nothing. */
    const buildPlan = Effect.fn("T3Import.buildPlan")(function* (
      source: T3SourceDatabase,
      scope: T3ImportScope,
      onProgress: (progress: T3ImportProgress) => Effect.Effect<void>,
    ) {
      const detected = yield* detectSource();
      const projectIds = resolveScope(scope, detected.projects);
      const sourceProjects = source
        .listProjects()
        .filter((project) => projectIds.includes(project.projectId));
      const rows = yield* cogenlyProjects;
      const ledgerProjects = new Map(
        (yield* sql<{ readonly source_project_id: string; readonly project_id: string }>`
          SELECT source_project_id, project_id FROM t3_import_projects
        `).map((row) => [row.source_project_id, row.project_id]),
      );
      const takenIds = new Set(
        (yield* sql<{
          readonly project_id: string;
        }>`SELECT project_id FROM projection_projects`).map((row) => row.project_id),
      );
      // T3 Code's scratch chats file under "No project": its id once it exists,
      // a stand-in the import resolves otherwise, or None without a Scratch.
      const noProjectId = Option.isNone(managedFolders)
        ? Option.none<ProjectId>()
        : Option.map(yield* managedFolders.value.scratchRoot, (root) => {
            const existing = findByRoot(rows, root);
            return existing === undefined
              ? NO_PROJECT_PENDING_ID
              : ProjectId.make(existing.project_id);
          });
      const skippedScratch = sourceProjects.some(
        (project) => isT3Scratch(project.workspaceRoot) && Option.isNone(noProjectId),
      );
      const targets = sourceProjects.flatMap((project): Array<ProjectTarget> => {
        if (isT3Scratch(project.workspaceRoot)) {
          return Option.match(noProjectId, {
            onNone: () => [],
            onSome: (projectId) => [
              { source: project, action: "merge", projectId, title: "No project", scratch: true },
            ],
          });
        }
        const recorded = ledgerProjects.get(project.projectId);
        const recordedRow = rows.find((row) => row.project_id === recorded);
        const existing = recordedRow ?? findByRoot(rows, project.workspaceRoot);
        if (existing !== undefined) {
          return [
            {
              source: project,
              action: "merge",
              projectId: ProjectId.make(existing.project_id),
              title: existing.title,
              scratch: false,
            },
          ];
        }
        const id = takenIds.has(project.projectId) ? `t3-${project.projectId}` : project.projectId;
        return [
          {
            source: project,
            action: "create",
            projectId: ProjectId.make(id),
            title: project.title,
            scratch: false,
          },
        ];
      });
      const projectIdMap = new Map(
        targets.map((target) => [target.source.projectId, target.projectId]),
      );
      const threads = yield* classifyThreads({
        source,
        threads: source.listThreads(sourceProjects.map((project) => project.projectId)),
        projectIds: projectIdMap,
      });
      const totalEvents = threads
        .filter((plan) => plan.mode === "new" || plan.mode === "update")
        .reduce((sum, plan) => sum + (plan.lastSequence > plan.afterSequence ? plan.events : 0), 0);
      yield* onProgress({ phase: "reading", processedEvents: 0, totalEvents });
      const context = mappingContext({ plans: threads, projectIds: projectIdMap });
      const summary = yield* replayEvents({
        source,
        plans: threads,
        context,
        onProgress: ({ processedEvents }) =>
          onProgress({ phase: "reading", processedEvents, totalEvents }),
        isCancelled: Ref.get(cancelRequested),
      });

      // Attachments: the files a thread owns by name, plus any its messages reference.
      const attachmentFiles = (() => {
        try {
          return NodeFS.readdirSync(sourceAttachmentsDir);
        } catch {
          return [];
        }
      })();
      const remap = context.threadIdRemap;
      const ownedSegments = new Map<string, string>();
      for (const plan of threads) {
        if (plan.mode !== "new" && plan.mode !== "update") continue;
        const segment = toSafeThreadAttachmentSegment(plan.source.threadId);
        if (segment !== null) ownedSegments.set(segment, plan.source.threadId);
      }
      const attachments: Array<ImportPlan["attachments"][number]> = [];
      const seen = new Set<string>();
      for (const name of attachmentFiles) {
        const id = NodePath.parse(name).name;
        const segment = parseThreadSegmentFromAttachmentId(id);
        const owner = segment === null ? undefined : ownedSegments.get(segment);
        if (owner === undefined && !summary.attachmentIds.has(id)) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        const from = NodePath.join(sourceAttachmentsDir, name);
        let bytes = 0;
        try {
          bytes = NodeFS.statSync(from).size;
        } catch {
          continue;
        }
        let target = name;
        for (const [fromId, toId] of remap) target = target.split(fromId).join(toId);
        attachments.push({ from, to: NodePath.join(config.attachmentsDir, target), bytes });
      }

      // Provider instances and preferences.
      const currentSettings = yield* settings.getSettings.pipe(Effect.orDie);
      const t3Settings = readJsonFile(NodePath.join(sourceDir, "settings.json"));
      const threadsByInstance = new Map<string, number>();
      for (const plan of threads) {
        const instance = plan.source.providerInstanceId;
        if (instance === null) continue;
        threadsByInstance.set(instance, (threadsByInstance.get(instance) ?? 0) + 1);
      }
      const providers = planProviderInstances({
        t3Settings,
        cogenlySettings: currentSettings,
        threadsByInstance,
      });
      const rawCogenlySettings = readJsonFile(config.settingsPath);
      const cogenlyKeybindings = Option.getOrElse(
        decodeKeybindings(readJsonFile(config.keybindingsConfigPath)),
        () => [],
      ).flatMap((rule) => Option.toArray(decodeRule(rule)));
      const preferences = planPreferences({
        t3Settings,
        t3Keybindings: readJsonFile(NodePath.join(sourceDir, "keybindings.json")),
        cogenlySettings: currentSettings,
        cogenlySettingKeys: new Set(
          typeof rawCogenlySettings === "object" && rawCogenlySettings !== null
            ? Object.keys(rawCogenlySettings)
            : [],
        ),
        cogenlyKeybindings,
      });

      const projectReports: Array<T3ImportProjectReport> = targets.map((target) => {
        const own = threads.filter((plan) => plan.source.projectId === target.source.projectId);
        const owned = new Set(
          own.map((plan) => toSafeThreadAttachmentSegment(plan.source.threadId)),
        );
        const files = attachments.filter((file) =>
          owned.has(parseThreadSegmentFromAttachmentId(NodePath.parse(file.from).name)),
        );
        return {
          sourceProjectId: target.source.projectId,
          title: target.source.title,
          workspaceRoot: target.source.workspaceRoot,
          action: target.action,
          projectId: target.projectId,
          projectTitle: target.title,
          threads: own.length,
          rootThreads: own.filter((plan) => plan.source.parentThreadId === null).length,
          subagentThreads: own.filter((plan) => plan.source.relationshipToParent === "subagent")
            .length,
          forkThreads: own.filter(
            (plan) =>
              plan.source.relationshipToParent !== "subagent" &&
              plan.source.forkedFromType !== null,
          ).length,
          messages: own.reduce((sum, plan) => sum + plan.messages, 0),
          events: own.reduce((sum, plan) => sum + plan.events, 0),
          attachments: files.length,
          attachmentBytes: files.reduce((sum, file) => sum + file.bytes, 0),
          upToDateThreads: own.filter((plan) => plan.mode === "up-to-date").length,
          updatedThreads: own.filter((plan) => plan.mode === "update").length,
          divergedThreads: own.filter((plan) => plan.mode === "diverged").length,
        };
      });

      const warnings: Array<string> = [];
      if (detected.running) warnings.push(T3_IMPORT_RUNNING_NOTE);
      if (skippedScratch) {
        warnings.push(
          'Chats from T3 Code without a project were left out: this environment has no "No project" to file them under.',
        );
      }
      for (const target of targets) {
        if (target.action === "create" && !NodeFS.existsSync(target.source.workspaceRoot)) {
          warnings.push(
            `The folder for ${target.source.title} (${target.source.workspaceRoot}) no longer exists.`,
          );
        }
      }
      for (const binding of providers.bindings) {
        if (binding.status === "conflict") {
          warnings.push(
            `Provider "${binding.instanceId}" is configured differently in Cogenly (or missing in T3 Code). Its ${binding.threads} threads import, but resuming them may start fresh sessions.`,
          );
        }
      }
      const diverged = threads.filter((plan) => plan.mode === "diverged").length;
      if (diverged > 0) {
        warnings.push(
          `${diverged} threads were continued in Cogenly after an earlier import; their newer T3 Code activity is not applied.`,
        );
      }
      const remapped = threads.filter((plan) => plan.threadId !== plan.source.threadId).length;
      if (remapped > 0)
        warnings.push(`${remapped} threads get new ids because Cogenly already uses theirs.`);

      const report: T3ImportReport = {
        reportId: `t3-import-report:${DateTime.formatIso(yield* DateTime.now)}`,
        generatedAt: DateTime.formatIso(yield* DateTime.now),
        scope: { sourceProjectIds: projectIds },
        projects: projectReports,
        totals: {
          threads: threads.length,
          messages: projectReports.reduce((sum, project) => sum + project.messages, 0),
          events: projectReports.reduce((sum, project) => sum + project.events, 0),
          newEvents: summary.events - summary.skippedEvents,
          attachments: attachments.length,
          attachmentBytes: attachments.reduce((sum, file) => sum + file.bytes, 0),
          skippedEvents: summary.skippedEvents,
          normalizedEvents: summary.normalizedEvents,
        },
        skipped: summary.skipped,
        providers: providers.bindings,
        settings: preferences.changes,
        warnings,
      };
      return {
        report,
        targets,
        threads,
        providers,
        preferences,
        summary,
        attachments,
      } satisfies ImportPlan;
    });

    /** Scan the held snapshot, taking a fresh one first. */
    const scanSnapshot = (scope: T3ImportScope) =>
      Effect.gen(function* () {
        yield* setProgress({ phase: "snapshot", processedEvents: 0, totalEvents: 0 });
        const snapshot = yield* takeSnapshot();
        return yield* withSource(snapshot.path, false, (source) =>
          withDeps(buildPlan(source, scope, (progress) => setProgress(progress))).pipe(
            Effect.catchTags({ SqlError: Effect.die }),
          ),
        ).pipe(Effect.map((plan) => plan.report));
      }).pipe(Effect.onError(() => dropSnapshot));

    const backupNow = Effect.fn("T3Import.backup")(function* () {
      const stamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
      const directory = NodePath.join(config.baseDir, "backups");
      const outPath = NodePath.join(directory, `cogenly-pre-t3-import-${stamp}.sqlite`);
      yield* backupDatabase({ dbPath: config.dbPath, outPath });
      for (const [file, suffix] of [
        [config.settingsPath, "settings.json"],
        [config.keybindingsConfigPath, "keybindings.json"],
      ] as const) {
        yield* Effect.sync(() => {
          if (NodeFS.existsSync(file)) {
            NodeFS.copyFileSync(
              file,
              NodePath.join(directory, `cogenly-pre-t3-import-${stamp}.${suffix}`),
            );
          }
        });
      }
      return outPath;
    });

    /** Import from the snapshot the confirmed scan read. */
    const importSnapshot = Effect.fn("T3Import.importSnapshot")(function* (
      snapshot: T3SourceSnapshot,
      input: {
        readonly scope: T3ImportScope;
        readonly includeSettings: boolean;
      },
    ) {
      return yield* withSource(
        snapshot.path,
        false,
        Effect.fnUntraced(function* (source) {
          const plan = yield* withDeps(
            buildPlan(source, input.scope, (progress) => setProgress(progress)),
          ).pipe(Effect.catchTags({ SqlError: Effect.die }));
          const totalEvents = plan.summary.events;
          yield* setProgress({ phase: "backup", processedEvents: 0, totalEvents });
          const backupPath = yield* withDeps(backupNow()).pipe(Effect.orDie);
          yield* SubscriptionRef.update(job, (current) =>
            current._tag === "Importing" ? { ...current, backupPath } : current,
          );

          yield* setProgress({ phase: "settings", processedEvents: 0, totalEvents });
          for (const create of plan.providers.creates) {
            yield* settings
              .updateProviderInstance({ operation: "create", ...create })
              .pipe(Effect.orDie);
          }
          if (input.includeSettings) {
            if (Object.keys(plan.preferences.patch).length > 0) {
              yield* settings.updateSettings(plan.preferences.patch).pipe(Effect.orDie);
            }
            for (const rule of plan.preferences.keybindings) {
              yield* keybindings.upsertKeybindingRule(rule).pipe(Effect.orDie);
            }
          }

          yield* setProgress({ phase: "projects", processedEvents: 0, totalEvents });
          const now = DateTime.formatIso(yield* DateTime.now);
          // A scan made before "No project" existed planned a stand-in id for it.
          const noProjectId =
            Option.isSome(managedFolders) && plan.targets.some((target) => target.scratch)
              ? (yield* managedFolders.value.ensureScratchProject.pipe(Effect.orDie)).projectId
              : null;
          const targets = plan.targets.map((target) =>
            target.scratch && noProjectId !== null ? { ...target, projectId: noProjectId } : target,
          );
          const scratchSources = new Set(
            targets.filter((target) => target.scratch).map((target) => target.source.projectId),
          );
          const threadPlans = plan.threads.map((thread) =>
            noProjectId !== null && scratchSources.has(thread.source.projectId)
              ? { ...thread, projectId: noProjectId }
              : thread,
          );
          for (const target of targets) {
            if (target.action === "create") {
              yield* projects
                .bootstrap({
                  commandId: CommandId.make(
                    `${T3_IMPORT_COMMAND_PREFIX}project:${target.source.projectId}`,
                  ),
                  projectId: target.projectId,
                  title: target.title,
                  workspaceRoot: target.source.workspaceRoot,
                })
                .pipe(Effect.orDie);
            }
            yield* sql`
              INSERT INTO t3_import_projects (source_project_id, project_id, workspace_root, action, imported_at)
              VALUES (${target.source.projectId}, ${target.projectId}, ${target.source.workspaceRoot}, ${target.action}, ${now})
              ON CONFLICT(source_project_id) DO UPDATE SET project_id = excluded.project_id
            `.pipe(Effect.orDie);
          }

          yield* setProgress({ phase: "events", processedEvents: 0, totalEvents });
          const projectIdMap = new Map(
            targets.map((target) => [target.source.projectId, target.projectId]),
          );
          const summary = yield* replayEvents({
            source,
            plans: threadPlans,
            context: mappingContext({ plans: threadPlans, projectIds: projectIdMap }),
            write: {
              eventSink,
              commandIdPrefix: `${T3_IMPORT_COMMAND_PREFIX}${now}`,
            },
            onProgress: ({ processedEvents }) =>
              setProgress({ phase: "events", processedEvents, totalEvents }),
            isCancelled: Ref.get(cancelRequested),
          }).pipe(withDeps, Effect.orDie);

          yield* setProgress({ phase: "attachments", processedEvents: totalEvents, totalEvents });
          let copiedAttachments = 0;
          yield* Effect.sync(() => NodeFS.mkdirSync(config.attachmentsDir, { recursive: true }));
          for (const file of plan.attachments) {
            const copied = yield* Effect.tryPromise(async () => {
              const existing = await NodeFS.promises.stat(file.to).catch(() => null);
              if (existing !== null && existing.size === file.bytes) return false;
              // Copied, never moved: T3's own install keeps working.
              await NodeFS.promises.copyFile(file.from, file.to);
              return true;
            }).pipe(Effect.orElseSucceed(() => false));
            if (copied) copiedAttachments += 1;
          }

          return {
            report: plan.report,
            backupPath,
            importedThreads: summary.threads.size,
            writtenEvents: summary.writtenEvents,
            skippedEvents: summary.skippedEvents,
            copiedAttachments,
            completedAt: DateTime.formatIso(yield* DateTime.now),
          } satisfies T3ImportResult;
        }),
      );
    });

    /** Run one job in the background; only one scan or import runs at a time. */
    const startJob = <A>(
      initial: T3ImportJob,
      work: Effect.Effect<A, T3ImportError>,
      onSuccess: (value: A) => T3ImportJob,
    ) =>
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(job);
        if (current._tag === "Scanning" || current._tag === "Importing") {
          return yield* failed("busy", "An import or scan is already running.");
        }
        yield* Ref.set(cancelRequested, false);
        yield* SubscriptionRef.set(job, initial);
        const fiber = yield* work.pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const state = yield* SubscriptionRef.get(job);
              const backupPath = state._tag === "Importing" ? state.backupPath : null;
              if (Exit.isSuccess(exit)) {
                yield* SubscriptionRef.set(job, onSuccess(exit.value));
              } else if (Cause.hasInterruptsOnly(exit.cause)) {
                yield* SubscriptionRef.set(job, {
                  _tag: "Cancelled",
                  backupPath,
                  writtenEvents: 0,
                });
              } else {
                const failure = Cause.findErrorOption(exit.cause);
                yield* Effect.logWarning("Import from T3 Code failed", { cause: exit.cause });
                yield* SubscriptionRef.set(job, {
                  _tag: "Failed",
                  message: Option.isSome(failure)
                    ? failure.value.detail
                    : `The import stopped: ${errorSummary(Cause.squash(exit.cause))}. Everything up to the last completed batch is saved; run it again to continue.`,
                  backupPath,
                });
              }
              yield* Ref.set(running, null);
            }),
          ),
          Effect.forkIn(serviceScope),
        );
        yield* Ref.set(running, fiber);
        return { started: true };
      });

    const scan = (input: T3ImportScanInput) =>
      startJob(
        { _tag: "Scanning", progress: { phase: "reading", processedEvents: 0, totalEvents: 0 } },
        scanSnapshot(input.scope).pipe(
          Effect.tap((report) =>
            Ref.set(latest, { reportId: report.reportId, scope: report.scope }),
          ),
        ),
        (report): T3ImportJob => ({ _tag: "Scanned", report }),
      );

    const run = (input: T3ImportRunInput) =>
      Effect.gen(function* () {
        const confirmed = yield* Ref.get(latest);
        const current = yield* SubscriptionRef.get(job);
        if (
          confirmed === null ||
          confirmed.reportId !== input.reportId ||
          current._tag !== "Scanned"
        ) {
          return yield* failed("stale-report", "Run a new dry run before importing.");
        }
        const snapshot = yield* Ref.get(heldSnapshot);
        if (snapshot === null) {
          return yield* failed("stale-report", "Run a new dry run before importing.");
        }
        return yield* startJob(
          {
            _tag: "Importing",
            report: current.report,
            progress: {
              phase: "backup",
              processedEvents: 0,
              totalEvents: current.report.totals.events,
            },
            backupPath: null,
          },
          importSnapshot(snapshot, {
            scope: confirmed.scope,
            includeSettings: input.includeSettings,
          }).pipe(Effect.ensuring(Effect.andThen(Ref.set(latest, null), dropSnapshot))),
          (result): T3ImportJob => ({ _tag: "Completed", result }),
        );
      });

    const cancel = Effect.gen(function* () {
      const fiber = yield* Ref.get(running);
      if (fiber === null) return { cancelled: false };
      // Checked between batches, so a batch is never half written.
      yield* Ref.set(cancelRequested, true);
      return { cancelled: true };
    });

    const status: Stream.Stream<T3ImportStatus> = Stream.unwrap(
      Effect.gen(function* () {
        const initial = yield* detectSource();
        const sourceRef = yield* Ref.make(initial);
        const polls = Stream.tick(SOURCE_POLL_INTERVAL).pipe(
          Stream.mapEffect(() =>
            Ref.get(sourceRef).pipe(
              Effect.map((source) => ({
                ...source,
                running: isT3ServerRunning(sourceDir),
              })),
              Effect.tap((source) => Ref.set(sourceRef, source)),
            ),
          ),
        );
        const jobs = SubscriptionRef.changes(job).pipe(
          Stream.mapEffect((current) =>
            // Refresh project counts and merge targets after a job settles.
            (current._tag === "Completed" || current._tag === "Scanned"
              ? detectSource().pipe(Effect.tap((source) => Ref.set(sourceRef, source)))
              : Effect.void
            ).pipe(Effect.as(current)),
          ),
        );
        let lastJob: T3ImportJob = yield* SubscriptionRef.get(job);
        return withStatusHeartbeat(
          Stream.merge(
            jobs.pipe(
              Stream.tap((current) =>
                Effect.sync(() => {
                  lastJob = current;
                }),
              ),
              Stream.as(undefined),
            ),
            polls.pipe(Stream.as(undefined)),
          ),
          Ref.get(sourceRef).pipe(
            Effect.map((source): T3ImportStatus => ({ source, job: lastJob })),
          ),
        );
      }),
    );

    return T3ImportService.of({
      status,
      scan,
      run,
      cancel,
    });
  });

export const layer = Layer.effect(T3ImportService, make());
export const layerWithOptions = (options: T3ImportServiceOptions) =>
  Layer.effect(T3ImportService, make(options));

import {
  GitCommandError,
  ThreadId,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderSessionJson,
} from "@cogenly/contracts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  OrchestrationV2ThreadShell,
  ServerSettings,
  ServerSettingsError,
  TerminalSummary,
  WorktreeCleanupRules,
  StorageCleanupReport,
  StorageCleanupReportEntry,
  StorageStatus,
} from "@cogenly/contracts";
import { resolveWorktreeCleanup } from "@cogenly/shared/projectSettings";
import { makeDrainableWorker } from "@cogenly/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import { threadHasQueuedTurnStart } from "./orchestration-v2/ThreadSettlementService.ts";
import { forkParked } from "./serverActivation.ts";
import * as Settings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { resolveProjectsRootDirectory } from "./project/ProjectsRoot.ts";
import {
  isFilesystemRoot,
  managedWorktreesDirectories,
  projectWorktreesDirectories,
} from "./worktreesDirectory.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as NodeSqliteClient from "@cogenly/shared/nodeSqliteClient";
import * as StorageInspection from "./housekeeping/StorageInspection.ts";
import * as ServerBackup from "./housekeeping/ServerBackup.ts";

const decodeCleanupThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeCleanupSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    OrchestrationV2ProviderSessionJson.mapFields(({ id, cwd }) => ({ id, cwd })),
  ),
);

const DAY_MS = 86_400_000;
// After a settle, the project's settle script needs time to open its
// terminal, which then protects the worktree.
const SETTLE_SCRIPT_GRACE_MS = 60_000;
// Worktree creation can precede its thread row, including review-guide checkouts.
const ORPHAN_WORKTREE_GRACE_MS = 60 * 60 * 1_000;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const REPORT_ENTRY_LIMIT = 200;
const isGitCommandError = Schema.is(GitCommandError);

function cleanupFailureReason(error: { readonly message: string }) {
  return isGitCommandError(error)
    ? `${error.command}: ${error.detail.split(/\r?\n/)[0]}${error.reason ? ` (${error.reason})` : ""}`
    : (error.message.split(/\r?\n/)[0] ?? error.message);
}

const worktreeCleanupEnabled = (rules: WorktreeCleanupRules) =>
  rules.worktreeAfterDays !== null ||
  rules.worktreeSettledAfterDays !== null ||
  rules.worktreeOnMerge ||
  rules.worktreeOnDelete ||
  rules.worktreeUnchanged;

/** Live sessions keep their cwd even when no turn is currently running. */
export function storageCleanupThreadIdle(thread: OrchestrationV2ThreadShell, now: number): boolean {
  return (
    thread.worktreePath !== null &&
    thread.activeRunId === null &&
    (thread.status === "idle" ||
      thread.status === "completed" ||
      thread.status === "interrupted" ||
      thread.status === "failed" ||
      thread.status === "cancelled" ||
      thread.status === "rolled_back") &&
    (thread.pendingBackgroundTasks?.length ?? 0) === 0 &&
    thread.pendingRuntimeRequest === null &&
    !threadHasQueuedTurnStart(thread, now)
  );
}

/** PR metadata refreshes must not reset the inactivity clock. */
export function storageCleanupActivityAt(thread: OrchestrationV2ThreadShell): number {
  return Math.max(
    ...[
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestRunRequestedAt,
      thread.latestRunStartedAt,
      thread.latestRunCompletedAt,
    ].flatMap((value) => (value == null ? [] : [DateTime.toEpochMillis(value)])),
  );
}

/** Only a complete subagent chain within this worktree shares ownership. */
function worktreeOwner(threads: ReadonlyArray<OrchestrationV2ThreadShell>) {
  if (threads.length === 1) return threads[0];
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const tops = threads.filter((thread) => !byId.has(thread.lineage.parentThreadId!));
  if (tops.length !== 1) return undefined;
  const owner = tops[0]!;
  for (const thread of threads) {
    let current = thread;
    const seen = new Set<string>();
    while (current.id !== owner.id) {
      if (
        seen.has(current.id) ||
        current.lineage.relationshipToParent !== "subagent" ||
        current.lineage.rootThreadId !== owner.lineage.rootThreadId
      )
        return undefined;
      seen.add(current.id);
      const parent = byId.get(current.lineage.parentThreadId!);
      if (parent === undefined) return undefined;
      current = parent;
    }
  }
  return owner;
}

/**
 * Whether the host's pull request proves this worktree's head was merged. A
 * squash or rebase merge leaves the head outside the default branch, so the
 * merged pull request then has to name this exact commit.
 */
export function storageCleanupPullRequestMerged(
  pullRequest: Pick<
    GitManager.GitBranchPullRequest,
    "state" | "headRef" | "baseRef" | "headSha"
  > | null,
  worktree: {
    readonly branch: string;
    readonly defaultBranch: string;
    readonly headSha: string;
    readonly integrated: boolean;
  },
): boolean {
  return (
    pullRequest?.state === "merged" &&
    (worktree.integrated ||
      (pullRequest.headRef === worktree.branch &&
        pullRequest.baseRef === worktree.defaultBranch &&
        pullRequest.headSha === worktree.headSha))
  );
}

export class StorageCleanup extends Context.Service<
  StorageCleanup,
  {
    readonly runNow: Effect.Effect<StorageCleanupReport, ServerSettingsError>;
    readonly preview: Effect.Effect<StorageCleanupReport, ServerSettingsError>;
    readonly status: Effect.Effect<StorageStatus, ServerSettingsError>;
    readonly latestReport: Effect.Effect<StorageCleanupReport | null>;
    readonly reports: Stream.Stream<StorageCleanupReport | null>;
    readonly drain: Effect.Effect<void>;
  }
>()("cogenly-server/storageCleanup") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const terminals = yield* TerminalManager.TerminalManager;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inspection = yield* StorageInspection.StorageInspection;
  const backups = yield* ServerBackup.ServerBackup;
  const liveTerminals = new Map<string, Map<string, TerminalSummary>>();
  const orphanSizes = new Map<string, number | null>();
  const noteTerminal = (terminal: TerminalSummary) => {
    const threadTerminals =
      liveTerminals.get(terminal.threadId) ?? new Map<string, TerminalSummary>();
    threadTerminals.set(terminal.terminalId, terminal);
    liveTerminals.set(terminal.threadId, threadTerminals);
  };

  const isWindows = yield* HostProcess.isWindows;
  const pathKey = (target: string) => {
    const resolved = path.resolve(target);
    return isWindows ? resolved.toLowerCase() : resolved;
  };
  const inside = (root: string, target: string) => {
    const relative = path.relative(pathKey(root), pathKey(target));
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const hasTerminal = (worktreePath: string) =>
    [...liveTerminals.values()]
      .flatMap((entries) => [...entries.values()])
      .some((terminal) => {
        if (terminal.status !== "starting" && terminal.status !== "running") return false;
        const cwd = path.resolve(terminal.cwd);
        return (
          (terminal.worktreePath !== null &&
            path.resolve(terminal.worktreePath) === worktreePath) ||
          cwd === worktreePath ||
          inside(worktreePath, cwd)
        );
      });

  const measureWorktree = (worktreePath: string) =>
    inspection.measure([{ path: worktreePath, category: "worktree" }]).pipe(
      Effect.map((totals) => totals.reduce((sum, entry) => sum + entry.exclusiveBytes, 0)),
      Effect.orElseSucceed(() => null),
    );

  // Archived owners protect shared checkouts too. Filtering before shell hydration
  // avoids reading every chat's run and message history for a cleanup sweep.
  const readThreads = Effect.fn("StorageCleanup.readThreads")(function* () {
    const { threads, archivedThreads } = yield* projections
      .getShellSnapshot({ worktreesOnly: true })
      .pipe(NodeSqliteClient.readOnly);
    const projects = yield* projectStore.listShells();
    return { projects, threads: [...threads, ...archivedThreads] };
  });

  // Local threads under another project need not have a worktreePath of their own.
  const containsProjectRoot = Effect.fn("StorageCleanup.containsProjectRoot")(function* (
    worktreePath: string,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
  ) {
    for (const project of projects) {
      const projectPath = path.resolve(project.workspaceRoot);
      if (pathKey(projectPath) === pathKey(worktreePath) || inside(worktreePath, projectPath))
        return true;
      const realPath = yield* fs
        .realPath(projectPath)
        .pipe(Effect.orElseSucceed(() => projectPath));
      if (pathKey(realPath) === pathKey(worktreePath) || inside(worktreePath, realPath))
        return true;
    }
    return false;
  });

  const reportOrphanWorktrees = Effect.fn("StorageCleanup.reportOrphanWorktrees")(function* (
    roots: ReadonlyArray<string>,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
    entries: StorageCleanupReportEntry[],
  ) {
    // Include deleted and archived threads, even those without a branch or project.
    const rows = yield* sql<{ worktreePath: string }>`
      SELECT DISTINCT json_extract(payload_json, '$.worktreePath') AS "worktreePath"
      FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL
    `.pipe(NodeSqliteClient.readOnly);
    const referenced = new Set<string>();
    for (const row of rows) {
      const resolved = path.resolve(row.worktreePath);
      referenced.add(pathKey(resolved));
      referenced.add(
        pathKey(yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved))),
      );
    }
    const referencedAncestors = new Set<string>();
    for (let ancestor of referenced) {
      while (roots.some((root) => inside(root, ancestor))) {
        ancestor = pathKey(path.dirname(ancestor));
        referencedAncestors.add(ancestor);
      }
    }
    const projectRoots = (yield* Effect.forEach(
      yield* Effect.filter(projects, (project) =>
        fs.exists(path.resolve(project.workspaceRoot)).pipe(Effect.orElseSucceed(() => true)),
      ),
      (project) => {
        const resolved = path.resolve(project.workspaceRoot);
        return fs.realPath(resolved).pipe(
          Effect.orElseSucceed(() => resolved),
          Effect.map((realPath) => [resolved, realPath]),
        );
      },
    )).flat();
    const inProject = (target: string, managedRoot: string) =>
      projectRoots.some(
        (root) =>
          !inside(root, managedRoot) && (pathKey(root) === pathKey(target) || inside(root, target)),
      );
    const directories = Effect.fnUntraced(function* (parent: string, managedRoot: string) {
      if (inProject(parent, managedRoot)) return [];
      const result: string[] = [];
      for (const name of yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => []))) {
        const target = path.join(parent, name);
        if (!inside(parent, target) || inProject(target, managedRoot)) continue;
        const directory = yield* Effect.gen(function* () {
          if (pathKey(yield* fs.realPath(target)) !== pathKey(target)) return false;
          return (yield* fs.stat(target)).type === "Directory";
        }).pipe(Effect.orElseSucceed(() => false));
        if (directory) result.push(target);
      }
      return result;
    });
    // Let the first walk reach its own limit so unmeasurable folders get cached.
    // Later walks share the remaining sweep budget.
    // Unmeasured folders still appear with an unknown size.
    const now = yield* Clock.currentTimeMillis;
    const measurementDeadline = now + 30_000;
    let firstMeasurement = true;
    const reported = new Set<string>();
    const report = Effect.fnUntraced(
      function* (worktreePath: string) {
        const key = pathKey(worktreePath);
        if (
          reported.has(key) ||
          referenced.has(key) ||
          referencedAncestors.has(key) ||
          projectRoots.some((root) => pathKey(root) === key || inside(worktreePath, root))
        )
          return;
        const modified = Option.getOrNull((yield* fs.stat(worktreePath)).mtime);
        if (modified !== null && modified.getTime() > now - ORPHAN_WORKTREE_GRACE_MS) return;
        const gitPath = path.join(worktreePath, ".git");
        const linked = (yield* fs.exists(gitPath)) && (yield* fs.stat(gitPath)).type === "File";
        reported.add(key);
        const remaining = measurementDeadline - (yield* Clock.currentTimeMillis);
        if (!orphanSizes.has(key) && (firstMeasurement || remaining > 0)) {
          const measured = yield* measureWorktree(worktreePath).pipe(
            firstMeasurement ? Effect.map(Option.some) : Effect.timeoutOption(remaining),
          );
          firstMeasurement = false;
          if (Option.isSome(measured)) orphanSizes.set(key, measured.value);
        }
        const bytes = orphanSizes.get(key) ?? null;
        entries.push({
          kind: "worktree",
          outcome: "kept",
          reason: linked
            ? "No thread uses this worktree"
            : "No thread uses this folder, and it isn't a git worktree",
          path: worktreePath,
          threadId: null,
          threadTitle: null,
          bytes,
          files: null,
        });
      },
      Effect.orElseSucceed(() => undefined),
    );
    for (const root of roots) {
      // Worktrees can be <root>/<repository>/<branch> or explicitly <root>/<name>.
      for (const projectDirectory of yield* directories(root, root)) {
        yield* Effect.gen(function* () {
          if (referenced.has(pathKey(projectDirectory))) return;
          const gitPath = path.join(projectDirectory, ".git");
          if (yield* fs.exists(gitPath)) {
            if ((yield* fs.stat(gitPath)).type === "File") yield* report(projectDirectory);
            return;
          }
          for (const worktreePath of yield* directories(projectDirectory, root)) {
            yield* report(worktreePath);
          }
        }).pipe(Effect.orElseSucceed(() => undefined));
      }
    }
    for (const key of orphanSizes.keys()) {
      if (!reported.has(key)) orphanSizes.delete(key);
    }
  });

  // Whether cwd stopped being a checkout of this branch. Two small Git reads,
  // since every worktree in a sweep is asked; statusDetailsLocal also diffs and
  // counts.
  const branchChanged = Effect.fn("StorageCleanup.branchChanged")(function* (
    cwd: string,
    branch: string | null,
  ) {
    const failure = (detail: string) =>
      new GitCommandError({
        operation: "StorageCleanup.branchChanged",
        command: "git",
        cwd,
        detail,
      });
    // Null when cwd is not a repository, or is gone. Git's own messages are
    // matched, so they must not be translated.
    const read = Effect.fnUntraced(function* (args: string[], allowedExitCode?: number) {
      const result = yield* git
        .execute({
          operation: "StorageCleanup.branchChanged",
          cwd,
          args,
          env: { LC_ALL: "C" },
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.flatMap(fs.exists(cwd), (exists) =>
              exists ? Effect.fail(error) : Effect.succeed(null),
            ),
          ),
        );
      if (result === null) return null;
      if (result.exitCode === 0 || result.exitCode === allowedExitCode) return result;
      if (result.stderr.toLowerCase().includes("not a git repository")) return null;
      return yield* failure(
        result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
      );
    });
    const index = yield* read(["rev-parse", "--git-path", "index"]);
    if (index === null) return true;
    // Another Git process is writing to this checkout.
    if (yield* fs.exists(`${path.resolve(cwd, index.stdout.trim())}.lock`))
      return yield* failure(
        "Git index is locked. Status will resume when the index lock is removed.",
      );
    // Exits 1 for a detached HEAD. Reads the full ref name, which is never
    // shortened to "heads/<branch>" when a tag shares the branch name.
    const head = yield* read(["symbolic-ref", "--quiet", "HEAD"], 1);
    if (head === null) return true;
    const ref = head.exitCode === 0 ? head.stdout.trim() : "";
    const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length).trim() : null;
    // Status output writes a detached HEAD as "(detached)", so a branch named
    // with a leading "(" has always been read as one.
    return (name?.startsWith("(") ? null : name) !== branch;
  });

  const cleanupGit = Effect.fn("StorageCleanup.cleanupGit")(function* (
    cwd: string,
    args: string[],
    command: string,
  ) {
    const result = yield* git.execute({
      operation: "StorageCleanup.cleanupGit",
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: 300_000,
    });
    if (result.exitCode !== 0)
      return yield* Effect.fail(
        new GitCommandError({
          operation: "StorageCleanup.cleanupGit",
          command,
          cwd,
          detail: result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
        }),
      );
  });

  const managedRoots = Effect.fn("StorageCleanup.managedRoots")(function* (
    serverSettings: ServerSettings,
  ) {
    const roots: Array<string> = [];
    // Project-local worktrees live under `<projectsRoot>/<entry>/worktrees`.
    const home = yield* HostProcess.HomeDirectory;
    const projectsRoot = resolveProjectsRootDirectory(
      serverSettings.projectsRoot,
      home,
      config.baseDir,
      path,
    );
    const projectEntries = yield* fs
      .readDirectory(projectsRoot)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    for (const directory of managedWorktreesDirectories(
      serverSettings,
      config.worktreesDir,
      path,
      home,
      projectWorktreesDirectories(projectsRoot, projectEntries, path),
    )) {
      // An unmounted drive only skips its own worktrees.
      const root = yield* fs.exists(directory).pipe(
        Effect.flatMap((exists) => (exists ? fs.realPath(directory) : Effect.succeed(null))),
        Effect.orElseSucceed(() => null),
      );
      if (root !== null && !isFilesystemRoot(root, path)) roots.push(root);
    }
    return roots;
  });

  const cleanWorktrees = Effect.fn("StorageCleanup.cleanWorktrees")(function* (
    serverSettings: ServerSettings,
    now: number,
    entries: StorageCleanupReportEntry[],
    dryRun: boolean,
  ) {
    const roots = yield* managedRoots(serverSettings);
    const deletedRows = yield* sql<{ payload_json: string; workspaceRoot: string }>`
          SELECT t.payload_json, p.workspace_root AS "workspaceRoot"
          FROM orchestration_v2_projection_threads t
          JOIN projection_projects p ON p.project_id = t.project_id
          WHERE t.deleted_at IS NOT NULL
        `;
    const deletedThreads = (yield* Effect.forEach(deletedRows, (row) =>
      decodeCleanupThread(row.payload_json).pipe(
        Effect.map((thread) => ({ ...thread, workspaceRoot: row.workspaceRoot })),
      ),
    )).filter((thread) => thread.worktreePath !== null && thread.branch !== null);
    const snapshot = yield* readThreads();
    const terminalTasks = yield* sql<{ childThreadId: string }>`
      SELECT child_thread_id AS "childThreadId" FROM orchestration_v2_projection_subagents
      WHERE origin = 'app_owned' AND child_thread_id IS NOT NULL
      GROUP BY child_thread_id
      HAVING SUM(CASE WHEN status NOT IN ('completed', 'failed', 'cancelled', 'interrupted') THEN 1 ELSE 0 END) = 0
    `;
    const terminalChildren = new Set(terminalTasks.map((task) => task.childThreadId));
    const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
    const refreshedDefaultRefs = new Map<string, Set<string>>();
    const groups = Map.groupBy(
      snapshot.threads.filter((thread) => thread.worktreePath !== null),
      (thread) => path.resolve(thread.worktreePath!),
    );
    const candidates = [
      ...[...groups.values()].map((group) => worktreeOwner(group) ?? group[0]!),
      ...deletedThreads.filter((thread) => !groups.has(path.resolve(thread.worktreePath!))),
    ];
    for (const thread of candidates) {
      const settings = resolveWorktreeCleanup(serverSettings);
      const worktreePath = path.resolve(thread.worktreePath!);
      const group = groups.get(worktreePath) ?? [];
      const activityAt = Math.max(...group.map(storageCleanupActivityAt));
      const deleted = "workspaceRoot" in thread;
      const parent =
        thread.lineage.parentThreadId === null
          ? undefined
          : threadsById.get(thread.lineage.parentThreadId);
      const terminalChild =
        terminalChildren.has(thread.id) &&
        thread.lineage.relationshipToParent === "subagent" &&
        parent?.worktreePath !== thread.worktreePath;
      if (
        !terminalChild &&
        !worktreeCleanupEnabled(settings) &&
        serverSettings.storageCleanup.dependenciesAfterDays === null
      )
        continue;
      const project = deleted
        ? { workspaceRoot: thread.workspaceRoot }
        : snapshot.projects.find((entry) => entry.id === thread.projectId);
      const entry: StorageCleanupReportEntry = {
        agentCreated:
          thread.createdBy === "agent" || thread.lineage.relationshipToParent === "subagent",
        kind: "worktree",
        outcome: "kept",
        reason: "",
        path: worktreePath,
        threadId: thread.id,
        threadTitle: thread.title,
        bytes: null,
        files: null,
      };
      const keep = (reason: string) => entries.push({ ...entry, reason: sentence(reason) });
      yield* Effect.gen(function* () {
        if (!(yield* fs.exists(worktreePath))) return;
        if (deleted && !settings.worktreeOnDelete) return keep("no rules apply");
        if (group.length > 1 && worktreeOwner(group) === undefined)
          return keep(`shared by ${group.length} threads`);
        if (project === undefined) return keep("project is unavailable");
        if (
          thread.branch === null ||
          (!deleted && !group.every((member) => storageCleanupThreadIdle(member, now)))
        )
          return keep("thread is running or has pending work");
        if (group.some((member) => member.branch !== thread.branch))
          return keep("a subagent thread's branch differs from this worktree's branch");
        const old =
          !deleted &&
          settings.worktreeAfterDays !== null &&
          activityAt < now - settings.worktreeAfterDays * DAY_MS;
        const retainedSince = thread.archivedAt ?? thread.settledAt;
        const settledFor =
          deleted || retainedSince === null
            ? null
            : now - Math.max(DateTime.toEpochMillis(retainedSince), activityAt);
        const settledDays = settledFor === null ? null : Math.floor(settledFor / DAY_MS);
        const settled =
          settledFor !== null &&
          settings.worktreeSettledAfterDays !== null &&
          settledFor >= settings.worktreeSettledAfterDays * DAY_MS;
        const dependencyDays = serverSettings.storageCleanup.dependenciesAfterDays;
        if (
          !terminalChild &&
          !deleted &&
          !old &&
          !settled &&
          !settings.worktreeOnMerge &&
          !settings.worktreeUnchanged &&
          !(dependencyDays !== null && activityAt < now - dependencyDays * DAY_MS)
        )
          return keep(
            retainedSince === null ? "not settled or archived" : "within the retention period",
          );
        if (hasTerminal(worktreePath)) return keep("open terminal");
        // Roots are canonical, so compare canonical paths. A symlinked parent
        // (a linked drive) is fine; a symlinked worktree directory is not.
        const realPath = yield* fs.realPath(worktreePath);
        const realParent = yield* fs.realPath(path.dirname(worktreePath));
        if (realPath !== path.join(realParent, path.basename(worktreePath)))
          return keep("worktree is a symbolic link");
        if (!roots.some((root) => inside(root, realPath)))
          return keep("outside the managed worktree folder");
        if (yield* containsProjectRoot(worktreePath, [project, ...snapshot.projects]))
          return keep("contains a project checkout");
        // A linked worktree has a .git file. Never remove a main checkout.
        if ((yield* fs.stat(path.join(worktreePath, ".git"))).type !== "File")
          return keep("not a linked worktree");
        if (yield* branchChanged(worktreePath, thread.branch))
          return keep("repository or branch changed");
        const changes = yield* inspection.gitBlocker(
          worktreePath,
          thread.branch,
          settings.worktreeKeepWhen === "any-local-files",
        );
        if (changes !== null) return keep(changes);
        // The project's settle script starts in the worktree right after a
        // settle. Settling stamps updatedAt now, even when automatic
        // settlement backdates settledAt to the thread's last activity.
        if (
          !deleted &&
          group.some(
            (member) =>
              member.settledAt !== null &&
              now - Math.max(DateTime.toEpochMillis(member.updatedAt), activityAt) <
                SETTLE_SCRIPT_GRACE_MS,
          )
        )
          return keep("settled moments ago");
        const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
        let eligible = terminalChild || deleted || old || settled;
        let removalReason = terminalChild
          ? "delegated task reached a terminal state"
          : deleted
            ? "thread was deleted"
            : old
              ? `inactive for ${Math.floor((now - activityAt) / DAY_MS)} days`
              : `settled for ${settledDays} days`;
        if (!eligible && (settings.worktreeUnchanged || settings.worktreeOnMerge)) {
          const repositoryCwd = path.resolve(project.workspaceRoot);
          const remote = yield* git.resolvePrimaryRemoteName(repositoryCwd);
          const branch = yield* git.resolveDefaultBranchName(repositoryCwd, remote);
          if (branch === null) return keep("default branch is unavailable");
          const defaultRef = `refs/remotes/${remote}/${branch}`;
          const refreshed = refreshedDefaultRefs.get(repositoryCwd) ?? new Set<string>();
          if (!dryRun && !refreshed.has(defaultRef)) {
            yield* git.fetchRemoteTrackingBranch({
              cwd: repositoryCwd,
              remoteName: remote,
              remoteBranch: branch,
            });
            refreshed.add(defaultRef);
            refreshedDefaultRefs.set(repositoryCwd, refreshed);
          }
          const base = yield* git.resolveCommit({
            cwd: worktreePath,
            revision: defaultRef,
          });
          const ancestor = yield* git.execute({
            operation: "StorageCleanup.integratedBranch",
            cwd: worktreePath,
            args: ["merge-base", "--is-ancestor", head.commitSha, base.commitSha],
            allowNonZeroExit: true,
          });
          const integrated = ancestor.exitCode === 0;
          eligible = integrated && settings.worktreeUnchanged;
          if (eligible) removalReason = "no commits beyond the default branch";
          if (!eligible && settings.worktreeOnMerge && thread.branch !== null) {
            const pullRequest = yield* gitManager.branchPullRequest(
              { cwd: worktreePath, branch: thread.branch },
              { refresh: !dryRun },
            );
            eligible = storageCleanupPullRequestMerged(pullRequest, {
              branch: thread.branch,
              defaultBranch: branch,
              headSha: head.commitSha,
              integrated,
            });
            if (eligible) removalReason = "pull request was merged";
          }
        }
        // Threads, queued deletion work and provider sessions as they are now, so a
        // queued turn, resumed session or new thread sharing this path cancels
        // the removal. Read only this path's threads: a full snapshot per
        // worktree takes seconds on large databases.
        const blockedSinceCheck = Effect.fnUntraced(function* () {
          const latestProjects = yield* projectStore.listShells();
          if (yield* containsProjectRoot(worktreePath, [project, ...latestProjects]))
            return "contains a project checkout";
          const latest = (yield* sql<{ threadId: string; worktreePath: string }>`
            SELECT thread_id AS "threadId", json_extract(payload_json, '$.worktreePath') AS "worktreePath"
            FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL
              AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
          `).filter((entry) => path.resolve(entry.worktreePath) === worktreePath);
          if (hasTerminal(worktreePath)) return "open terminal";
          if (deleted) {
            if (
              latest.length > 0 ||
              !resolveWorktreeCleanup(yield* settingsService.getSettings).worktreeOnDelete
            )
              return "thread or cleanup settings changed since check";
            // V2 deletion queues durable cleanup. Do not remove its checkout until
            // every effect has finished successfully or was explicitly cancelled.
            const pendingCleanup = yield* sql`
              SELECT 1 FROM orchestration_v2_effect_outbox
              WHERE thread_id = ${thread.id} AND status NOT IN ('succeeded', 'cancelled') LIMIT 1
            `;
            if (pendingCleanup.length > 0) return "thread deletion is still pending";
          } else {
            const latestShells = yield* Effect.forEach(latest, (entry) =>
              projections.getThreadShell(ThreadId.make(entry.threadId)),
            );
            const latestGroup = latestShells.filter((shell) => shell !== null);
            const latestOwner = worktreeOwner(latestGroup);
            if (
              latestGroup.length !== group.length ||
              latestOwner?.id !== thread.id ||
              latestOwner?.branch !== thread.branch ||
              latestGroup.some((shell) => {
                const previous = group.find((member) => member.id === shell.id);
                return (
                  previous === undefined ||
                  shell.branch !== thread.branch ||
                  !Equal.equals(shell.settledAt, previous.settledAt) ||
                  !Equal.equals(shell.archivedAt, previous.archivedAt) ||
                  (shell.settledAt !== null &&
                    !Equal.equals(shell.updatedAt, previous.updatedAt)) ||
                  !storageCleanupThreadIdle(shell, now) ||
                  path.resolve(shell.worktreePath!) !== worktreePath ||
                  storageCleanupActivityAt(shell) !== storageCleanupActivityAt(previous)
                );
              })
            )
              return "thread activity or shared worktree changed since check";
          }
          // Sessions can outlive their run and can be shared across app threads.
          const sessionRows = yield* sql<{ payload_json: string }>`
            SELECT payload_json FROM orchestration_v2_projection_provider_sessions
            WHERE status != 'stopped'
          `;
          const sessions = yield* Effect.forEach(sessionRows, (row) =>
            decodeCleanupSession(row.payload_json),
          );
          // A stored session can stay ready after its runtime was released,
          // for example once every thread detached; only a live one holds it.
          for (const session of sessions) {
            const cwd = path.resolve(session.cwd);
            if (
              (cwd === worktreePath || inside(worktreePath, cwd)) &&
              (yield* providerSessions.isLive(session.id))
            )
              return "provider session is still open";
          }
          // Other shells, dev servers and provider-native children are not all
          // registered with TerminalManager. Unknown host inventory is unsafe.
          const process = yield* inspection.processBlocker(worktreePath);
          if (process !== null) return process;
          const pending = yield* sql`
            SELECT 1 FROM orchestration_v2_effect_outbox
            WHERE thread_id IN (SELECT thread_id FROM orchestration_v2_projection_threads
              WHERE json_extract(payload_json, '$.worktreePath') = ${thread.worktreePath})
              AND status NOT IN ('succeeded', 'cancelled') LIMIT 1
          `;
          if (pending.length > 0) return "thread effects are still pending";
          return null;
        });
        // Most cancelled removals are caught here, before the worktree is walked.
        const blocked = yield* blockedSinceCheck();
        if (blocked !== null) return keep(blocked);
        if (!eligible) {
          const days = serverSettings.storageCleanup.dependenciesAfterDays;
          if (days !== null && activityAt < now - days * DAY_MS) {
            const ignored = yield* git.execute({
              operation: "StorageCleanup.dependencies",
              cwd: worktreePath,
              args: [
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
                "-z",
              ],
              maxOutputBytes: 256 * 1024,
            });
            if (ignored.stdoutTruncated) return keep("dependency inspection exceeded the limit");
            for (const relative of ignored.stdout
              .split("\0")
              .filter((file) => /(^|\/)(node_modules|\.turbo|dist)\/$/.test(file))) {
              const target = path.resolve(realPath, relative);
              if (!inside(realPath, target) || (yield* fs.realPath(target)) !== target) continue;
              const measured = yield* inspection.measure([
                { path: target, category: "dependencies" },
              ]);
              if ((yield* blockedSinceCheck()) !== null) return keep("worktree became busy");
              if (
                (yield* settingsService.getSettings).storageCleanup.dependenciesAfterDays !== days
              )
                return keep("dependency cleanup settings changed since check");
              if (yield* branchChanged(worktreePath, thread.branch))
                return keep("branch changed since check");
              const changed = yield* inspection.gitBlocker(
                worktreePath,
                thread.branch,
                settings.worktreeKeepWhen === "any-local-files",
              );
              if (changed !== null) return keep(changed);
              if (!dryRun) {
                const marker = yield* git.execute({
                  operation: "StorageCleanup.dependencies",
                  cwd: worktreePath,
                  args: ["rev-parse", "--git-path", "cogenly-dependencies-pruned"],
                });
                yield* fs.writeFileString(
                  path.resolve(worktreePath, marker.stdout.trim()),
                  "Setup required before next turn.\n",
                );
                yield* fs.remove(target, { recursive: true });
              }
              entries.push({
                ...entry,
                kind: "dependencies",
                outcome: "removed",
                path: target,
                reason: dryRun
                  ? "Would prune rebuildable dependencies"
                  : "Pruned rebuildable dependencies",
                bytes: measured.reduce((total, category) => total + category.exclusiveBytes, 0),
              });
            }
          }
          return keep(
            !deleted && settings.worktreeAfterDays !== null
              ? `inactive for ${Math.floor((now - activityAt) / DAY_MS)} of ${settings.worktreeAfterDays} days`
              : settings.worktreeSettledAfterDays !== null
                ? settledFor === null
                  ? "not settled"
                  : `settled for ${settledDays} of ${settings.worktreeSettledAfterDays} days`
                : settings.worktreeOnMerge
                  ? "not merged"
                  : "has commits beyond the default branch",
          );
        }
        const bytes = yield* inspection
          .measure([{ path: worktreePath, category: "worktree" }])
          .pipe(
            Effect.map((categories) =>
              categories.reduce((total, category) => total + category.exclusiveBytes, 0),
            ),
          );
        // The walk can take a while; ask again for anything that started during it.
        const blockedWhileMeasuring = yield* blockedSinceCheck();
        if (blockedWhileMeasuring !== null) return keep(blockedWhileMeasuring);
        if (yield* branchChanged(worktreePath, thread.branch))
          return keep("repository or branch changed since check");
        if (
          (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha !==
          head.commitSha
        )
          return keep("commit changed since check");
        const finalChanges = yield* inspection.gitBlocker(
          worktreePath,
          thread.branch,
          settings.worktreeKeepWhen === "any-local-files",
        );
        if (finalChanges !== null) return keep(finalChanges);
        const current = resolveWorktreeCleanup(yield* settingsService.getSettings);
        if (
          Object.keys(settings).some(
            (key) =>
              current[key as keyof typeof settings] !== settings[key as keyof typeof settings],
          )
        )
          return keep("settings changed since check");
        if (dryRun) {
          entries.push({
            ...entry,
            outcome: "removed",
            reason: `Would remove: ${removalReason}`,
            bytes,
          });
          return;
        }
        yield* cleanupGit(
          project.workspaceRoot,
          ["-c", "status.showUntrackedFiles=normal", "worktree", "remove", worktreePath],
          "git worktree remove",
        );
        entries.push({ ...entry, outcome: "removed", reason: sentence(removalReason), bytes });
        yield* gitManager.invalidateStatus(project.workspaceRoot);
        // Preserve branch and path: ProviderTurnStartService recreates the checkout
        // from that branch when the thread is resumed.
        yield* Effect.logInfo("storage cleanup removed worktree", { threadId: thread.id });
      }).pipe(
        (effect) => withWorkspaceLease(worktreePath, effect),
        Effect.catch((error) =>
          Effect.gen(function* () {
            entries.push({
              ...entry,
              outcome: "failed",
              reason: cleanupFailureReason(error),
            });
            yield* Effect.logWarning("storage cleanup failed for worktree", {
              threadId: thread.id,
              error,
            });
          }),
        ),
      );
    }
    yield* reportOrphanWorktrees(
      roots,
      yield* projectStore.list({ includeDeleted: true }),
      entries,
    );
  });

  const cleanFiles = Effect.fn("StorageCleanup.cleanFiles")(function* (
    root: string,
    days: number | null,
    now: number,
    rotatedLogs: boolean,
    // Owned by the caller so files removed before a failure still count.
    removed: { files: number; bytes: number },
    dryRun: boolean,
  ) {
    if (days === null || !(yield* fs.exists(root))) return removed;
    const realRoot = yield* fs.realPath(root);
    const realParent = yield* fs.realPath(path.dirname(root));
    if (realRoot !== path.join(realParent, path.basename(root))) return removed;
    const visit = Effect.fn("StorageCleanup.visitFiles")(function* (
      directory: string,
    ): Effect.fn.Return<void, PlatformError | ServerSettingsError> {
      for (const name of yield* fs.readDirectory(directory)) {
        const target = path.join(directory, name);
        if ((yield* fs.realPath(target)) !== target || !inside(realRoot, target)) continue;
        const stat = yield* fs.stat(target);
        if (stat.type === "Directory") {
          yield* visit(target);
        } else if (stat.type === "File" && (!rotatedLogs || /\.(?:log|ndjson)\.\d+$/.test(name))) {
          const modified = Option.getOrNull(stat.mtime);
          if (modified !== null && modified.getTime() < now - days * DAY_MS) {
            const current = (yield* settingsService.getSettings).storageCleanup;
            if ((rotatedLogs ? current.logsAfterDays : current.browserArtifactsAfterDays) !== days)
              return;
            if (!dryRun) yield* fs.remove(target);
            removed.files++;
            removed.bytes +=
              Option.getOrElse(stat.nlink, () => 1n) <= 1n
                ? Number(Option.getOrElse(stat.blocks, () => 0n)) * 512
                : 0;
          }
        }
      }
    });
    yield* visit(realRoot);
    return removed;
  });

  const status = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    const roots = yield* managedRoots(settings);
    // Storage classification needs ownership paths, not run/message summaries.
    const ownedPaths = yield* sql<{ worktreePath: string }>`
      SELECT DISTINCT json_extract(payload_json, '$.worktreePath') AS "worktreePath"
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
        AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
        AND (json_extract(payload_json, '$.createdBy') = 'agent'
          OR json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent')
    `.pipe(NodeSqliteClient.readOnly);
    const agentPaths = yield* Effect.forEach(ownedPaths, (entry) => {
      const target = path.resolve(entry.worktreePath);
      return fs.realPath(target).pipe(Effect.orElseSucceed(() => target));
    });
    const categories = yield* inspection
      .measure(
        [
          ...roots.map((root) => ({ path: root, category: "user-worktrees" })),
          { path: config.browserArtifactsDir, category: "browser-artifacts" },
          { path: config.logsDir, category: "logs" },
          { path: path.join(config.baseDir, "backups"), category: "backups" },
        ],
        (target, category) => {
          if (category === "logs" || category === "browser-artifacts" || category === "backups")
            return category;
          const relative =
            roots
              .map((root) => path.relative(root, target))
              .find((value) => !value.startsWith("..") && !path.isAbsolute(value)) ?? "";
          const segments = relative.split(path.sep);
          if (segments.includes(".cogenly")) return "dev-data";
          if (segments.some((segment) => ["node_modules", ".turbo", "dist"].includes(segment)))
            return "dependencies";
          return agentPaths.some((root) => target === root || inside(root, target))
            ? "agent-worktrees"
            : "user-worktrees";
        },
      )
      .pipe(Effect.option);
    const volumes = yield* inspection.volumes([...roots, config.baseDir]).pipe(Effect.option);
    const sharedBlocks =
      Option.isNone(volumes) || volumes.value.some((volume) => volume.sharedBlocksMayExist);
    const databaseBytes = yield* fs.stat(config.dbPath).pipe(
      Effect.map((stat) => Number(stat.size)),
      Effect.orElseSucceed(() => null),
    );
    return {
      measuredAt: DateTime.formatIso(yield* DateTime.now),
      volumes: Option.getOrElse(volumes, () => []),
      databaseBytes,
      categories: Option.getOrElse(categories, () => []).map((category) => ({
        category: category.category,
        files: category.files,
        bytes: sharedBlocks ? null : category.bytes,
      })),
      complete: Option.isSome(categories) && Option.isSome(volumes),
    };
  }).pipe(
    Effect.catch(() =>
      Effect.map(DateTime.now, (now) => ({
        measuredAt: DateTime.formatIso(now),
        categories: [],
        volumes: [],
        databaseBytes: null,
        complete: false,
      })),
    ),
  );

  const reportRef = yield* SubscriptionRef.make<StorageCleanupReport | null>(null);
  const sweep = Effect.fn("StorageCleanup.sweep")(function* (
    trigger: StorageCleanupReport["trigger"],
    dryRun = false,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const serverSettings = yield* settingsService.getSettings;
    const settings = serverSettings.storageCleanup;
    const diskPaths = [...(yield* managedRoots(serverSettings)), config.baseDir];
    const before = yield* inspection.volumes(diskPaths).pipe(Effect.option);
    const entries: StorageCleanupReportEntry[] = [];
    yield* cleanWorktrees(serverSettings, now, entries, dryRun).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          entries.push({
            kind: "worktree",
            outcome: "failed",
            reason: cleanupFailureReason(error),
            path: null,
            threadId: null,
            threadTitle: null,
            bytes: null,
            files: null,
          });
          yield* Effect.logWarning("worktree cleanup failed", { error });
        }),
      ),
    );
    for (const category of [
      {
        kind: "browser-artifacts" as const,
        root: config.browserArtifactsDir,
        days: settings.browserArtifactsAfterDays,
        label: "browser artifacts",
      },
      {
        kind: "logs" as const,
        root: config.logsDir,
        days: settings.logsAfterDays,
        label: "rotated logs",
      },
    ]) {
      if (category.days === null) continue;
      const removed = { files: 0, bytes: 0 };
      yield* cleanFiles(
        category.root,
        category.days,
        now,
        category.kind === "logs",
        removed,
        dryRun,
      ).pipe(
        Effect.map(({ files, bytes }) =>
          entries.push({
            kind: category.kind,
            outcome: files > 0 ? "removed" : "kept",
            reason: files === 0 ? "No expired files" : `Removed ${files} ${category.label}`,
            path: null,
            threadId: null,
            threadTitle: null,
            bytes: files > 0 ? bytes : null,
            files: files > 0 ? files : null,
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            entries.push({
              kind: category.kind,
              outcome: "failed",
              reason: cleanupFailureReason(error),
              path: null,
              threadId: null,
              threadTitle: null,
              bytes: removed.files > 0 ? removed.bytes : null,
              files: removed.files > 0 ? removed.files : null,
            });
            yield* Effect.logWarning("storage file cleanup failed", { kind: category.kind, error });
          }),
        ),
      );
    }
    yield* backups.pruneBackups(dryRun).pipe(
      Effect.tap((paths) =>
        Effect.sync(() => {
          for (const backup of paths)
            entries.push({
              kind: "backups",
              outcome: "removed",
              reason: dryRun ? "Would remove expired backup" : "Removed expired backup",
              path: backup,
              threadId: null,
              threadTitle: null,
              bytes: null,
              files: null,
            });
        }),
      ),
      Effect.catch((error) =>
        Effect.sync(() =>
          entries.push({
            kind: "backups",
            outcome: "failed",
            reason: error.message,
            path: null,
            threadId: null,
            threadTitle: null,
            bytes: null,
            files: null,
          }),
        ),
      ),
    );
    const sharedBlocks =
      Option.isNone(before) || before.value.some((volume) => volume.sharedBlocksMayExist);
    if (sharedBlocks)
      for (let index = 0; index < entries.length; index++)
        entries[index] = { ...entries[index]!, bytes: null };
    const counts = { removed: 0, kept: 0, failed: 0 };
    let bytesFreed = 0;
    for (const entry of entries) {
      counts[entry.outcome]++;
      if (entry.outcome !== "kept") bytesFreed += entry.bytes ?? 0;
    }
    let spaceMeasurement: StorageCleanupReport["spaceMeasurement"] = "unknown";
    if (!dryRun && Option.isSome(before)) {
      const after = yield* inspection.volumes(diskPaths).pipe(Effect.option);
      if (
        Option.isSome(after) &&
        before.value.every((volume) => after.value.some((current) => current.id === volume.id))
      ) {
        bytesFreed = Math.max(
          0,
          before.value.reduce(
            (total, volume) =>
              total +
              (after.value.find((current) => current.id === volume.id)!.availableBytes -
                volume.availableBytes),
            0,
          ),
        );
        if (counts.removed === 0) bytesFreed = 0;
        spaceMeasurement = "volume-change";
      } else bytesFreed = 0;
    } else if (sharedBlocks) bytesFreed = 0;
    const priority = (entry: StorageCleanupReportEntry) =>
      entry.outcome === "failed"
        ? 0
        : entry.outcome === "removed"
          ? 1
          : entry.kind === "worktree" && entry.threadId === null
            ? 2
            : 3;
    const latestReport: StorageCleanupReport = {
      dryRun,
      spaceMeasurement,
      unsavedAgentWorktrees: entries.filter(
        (entry) =>
          entry.kind === "worktree" &&
          entry.agentCreated === true &&
          entry.outcome === "kept" &&
          /unsaved|uncommitted|stashed|ignored local files/.test(entry.reason),
      ).length,
      trigger,
      startedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      finishedAt: DateTime.formatIso(yield* DateTime.now),
      entries: entries.sort((a, b) => priority(a) - priority(b)).slice(0, REPORT_ENTRY_LIMIT),
      counts,
      bytesFreed,
      omittedCount: Math.max(0, entries.length - REPORT_ENTRY_LIMIT),
    };
    if (!dryRun) yield* SubscriptionRef.set(reportRef, latestReport);
    return latestReport;
  });
  // At most one automatic sweep waits at a time. An automatic request made
  // while one is waiting joins it, since that sweep has not read any state yet.
  // Each manual run still gets its own sweep and report.
  const automaticSweepQueued = yield* Ref.make(false);
  const worker = yield* makeDrainableWorker(
    (completion: Deferred.Deferred<StorageCleanupReport, ServerSettingsError> | undefined) =>
      (completion === undefined ? Ref.set(automaticSweepQueued, false) : Effect.void).pipe(
        Effect.andThen(sweep(completion === undefined ? "automatic" : "manual")),
        Effect.exit,
        Effect.flatMap((exit) =>
          completion === undefined
            ? exit.pipe(
                Effect.asVoid,
                Effect.catchCause((cause) =>
                  Effect.logWarning("storage cleanup failed", { cause }),
                ),
              )
            : Deferred.done(completion, exit).pipe(Effect.asVoid),
        ),
      ),
  );
  const requestSweep = Ref.getAndSet(automaticSweepQueued, true).pipe(
    Effect.flatMap((queued) => (queued ? Effect.void : worker.enqueue(undefined))),
  );
  const runNow = Effect.gen(function* () {
    const completion = yield* Deferred.make<StorageCleanupReport, ServerSettingsError>();
    yield* worker.enqueue(completion);
    return yield* Deferred.await(completion);
  });

  const start = Effect.fn("StorageCleanup.start")(function* () {
    const unsubscribe = yield* terminals.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") {
          liveTerminals.clear();
          for (const terminal of event.terminals) noteTerminal(terminal);
        } else if (event.type === "upsert") {
          noteTerminal(event.terminal);
        } else {
          const threadTerminals = liveTerminals.get(event.threadId);
          threadTerminals?.delete(event.terminalId);
          if (threadTerminals?.size === 0) liveTerminals.delete(event.threadId);
        }
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    const changes = yield* settingsService.subscribeChanges;
    const events = engine.streamDomainEvents;
    let lastSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    yield* forkParked(
      requestSweep.pipe(
        Effect.andThen(worker.drain),
        Effect.repeat(Schedule.spaced("1 hour")),
        Effect.asVoid,
      ),
    );
    yield* forkParked(
      Stream.runForEach(changes, (settings) => {
        if (
          Equal.equals(settings.automaticBackups, lastSettings.automaticBackups) &&
          Equal.equals(settings.storageCleanup, lastSettings.storageCleanup) &&
          Equal.equals(settings.worktreeCleanup, lastSettings.worktreeCleanup)
        )
          return Effect.void;
        lastSettings = settings;
        return requestSweep;
      }),
    );
    yield* forkParked(
      // A deleted thread's worktree waits for its sessions to end. Moving
      // between live statuses, such as running to ready, cannot free one.
      Stream.runForEach(events, (event) =>
        event.type === "thread.deleted" ||
        (event.type === "subagent.updated" &&
          ["completed", "failed", "cancelled", "interrupted"].includes(event.payload.status)) ||
        (event.type === "run.updated" &&
          ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
            event.payload.status,
          )) ||
        event.type === "thread.settled" ||
        event.type === "thread.archived" ||
        (event.type === "provider-session.updated" &&
          (event.payload.status === "stopped" || event.payload.status === "error"))
          ? requestSweep
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Storage cleanup event stream failed", { cause }),
        ),
      ),
    );
  });
  yield* start();
  return StorageCleanup.of({
    runNow,
    preview: sweep("manual", true),
    status,
    latestReport: SubscriptionRef.get(reportRef),
    reports: SubscriptionRef.changes(reportRef),
    drain: worker.drain,
  });
});

export const layer = Layer.effect(StorageCleanup, make);

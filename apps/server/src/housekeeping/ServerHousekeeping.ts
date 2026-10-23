/**
 * ServerHousekeeping - Built-in periodic cleanup owned by the server.
 *
 * No cron, no scheduled agent task, no provider turn. Each run:
 * - removes orphaned agent worktrees whose thread is deleted or archived
 *   (or gone entirely), but only when Git proves the worktree has neither
 *   uncommitted changes nor unpushed commits — anything else is logged and
 *   kept;
 * - prunes log files older than the retention window;
 * - runs `PRAGMA optimize` and, when incremental auto_vacuum is on and free
 *   pages exist, a bounded `PRAGMA incremental_vacuum`.
 *
 * The decisions live in the pure planners below so they are unit-tested
 * without a filesystem; `runNow` only gathers facts and applies the plan.
 * `runNow` is the service method an agent or transport can trigger later.
 *
 * @module ServerHousekeeping
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const DAY_MS = 86_400_000;
/** Log retention when `storageCleanup.logsAfterDays` is unset. */
const DEFAULT_LOG_RETENTION_DAYS = 30;
/** Free pages returned per housekeeping pass; matches DatabaseStorage. */
const VACUUM_PAGES_PER_PASS = 1024;

export class ServerHousekeepingError extends Schema.TaggedError<ServerHousekeepingError>()(
  "ServerHousekeepingError",
  {
    operation: Schema.Literals(["list-worktrees", "list-logs", "database"]),
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Server housekeeping ${this.operation} failed at ${this.path}.`;
  }
}

export const isServerHousekeepingError = Schema.is(ServerHousekeepingError);

// ── Pure planners ────────────────────────────────────────────────────────────

export type WorktreeThreadState = "deleted" | "archived" | "active" | "missing";

export interface WorktreeCandidate {
  readonly worktreePath: string;
  readonly threadState: WorktreeThreadState;
  /** Null when Git could not inspect the worktree; unknown is never removed. */
  readonly hasUncommittedChanges: boolean | null;
  /** Null when Git could not determine push state; unknown is never removed. */
  readonly hasUnpushedCommits: boolean | null;
  readonly isLinkedWorktree: boolean;
}

export interface PlannedWorktreeKeep {
  readonly worktreePath: string;
  readonly reason: string;
}

/**
 * The worktree safety rule: a worktree is removed only when its thread is
 * deleted, archived, or gone, it is a linked worktree, and Git proved it has
 * no uncommitted changes and no unpushed commits. Every other candidate is
 * kept with the reason, so the caller can log and skip it.
 */
export const planWorktreeCleanup = (
  candidates: ReadonlyArray<WorktreeCandidate>,
): {
  readonly remove: ReadonlyArray<string>;
  readonly keep: ReadonlyArray<PlannedWorktreeKeep>;
} => {
  const remove: string[] = [];
  const keep: PlannedWorktreeKeep[] = [];
  for (const candidate of candidates) {
    const keepWith = (reason: string) =>
      keep.push({ worktreePath: candidate.worktreePath, reason });
    if (candidate.threadState === "active") {
      keepWith("thread is still active");
    } else if (!candidate.isLinkedWorktree) {
      keepWith("not a linked worktree");
    } else if (candidate.hasUncommittedChanges === null || candidate.hasUnpushedCommits === null) {
      keepWith("could not inspect git state");
    } else if (candidate.hasUncommittedChanges) {
      keepWith("has uncommitted changes");
    } else if (candidate.hasUnpushedCommits) {
      keepWith("has unpushed commits");
    } else {
      remove.push(candidate.worktreePath);
    }
  }
  return { remove, keep };
};

export interface LogFileCandidate {
  readonly path: string;
  readonly modifiedAtMs: number;
}

/** Pure log retention: remove files last modified before the retention window. */
export const planLogPruning = (
  files: ReadonlyArray<LogFileCandidate>,
  nowMs: number,
  retentionDays: number | null,
): { readonly remove: ReadonlyArray<string>; readonly keep: ReadonlyArray<string> } => {
  if (retentionDays === null) return { remove: [], keep: files.map((file) => file.path) };
  const cutoff = nowMs - retentionDays * DAY_MS;
  const remove: string[] = [];
  const keep: string[] = [];
  for (const file of files) {
    (file.modifiedAtMs < cutoff ? remove : keep).push(file.path);
  }
  return { remove, keep };
};

export interface DatabaseMaintenancePlan {
  readonly runOptimize: boolean;
  readonly runIncrementalVacuum: boolean;
}

/**
 * Pure database decision: `PRAGMA optimize` is cheap and idempotent, so it
 * runs every pass. Incremental vacuum only helps when the database uses
 * incremental auto_vacuum and actually holds free pages.
 */
export const planDatabaseMaintenance = (input: {
  readonly incrementalVacuumEnabled: boolean;
  readonly freelistCount: number;
}): DatabaseMaintenancePlan => ({
  runOptimize: true,
  runIncrementalVacuum: input.incrementalVacuumEnabled && input.freelistCount > 0,
});

// ── Service ──────────────────────────────────────────────────────────────────

export interface HousekeepingReport {
  readonly removedWorktrees: ReadonlyArray<string>;
  readonly keptWorktrees: ReadonlyArray<PlannedWorktreeKeep>;
  readonly removedLogFiles: number;
  readonly databaseOptimizeRun: boolean;
  readonly databaseVacuumRun: boolean;
}

export class ServerHousekeeping extends Context.Service<
  ServerHousekeeping,
  {
    /** Run one housekeeping pass now. The parked fiber calls this on a timer. */
    readonly runNow: Effect.Effect<HousekeepingReport, ServerHousekeepingError>;
  }
>()("cogenly-server/housekeeping/ServerHousekeeping") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const listCandidates = Effect.fn("ServerHousekeeping.listCandidates")(function* () {
    const rows = yield* sql<{
      worktreePath: string;
      workspaceRoot: string;
      state: string;
    }>`
      SELECT DISTINCT
        json_extract(t.payload_json, '$.worktreePath') AS "worktreePath",
        p.workspace_root AS "workspaceRoot",
        CASE
          WHEN t.deleted_at IS NOT NULL THEN 'deleted'
          WHEN json_extract(t.payload_json, '$.archivedAt') IS NOT NULL THEN 'archived'
          ELSE 'active'
        END AS state
      FROM orchestration_v2_projection_threads t
      JOIN projection_projects p ON p.project_id = t.project_id
      WHERE json_extract(t.payload_json, '$.worktreePath') IS NOT NULL
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ServerHousekeepingError({
            operation: "list-worktrees",
            path: config.dbPath,
            cause,
          }),
      ),
    );
    const workspaceByPath = new Map<string, string>();
    const stateByPath = new Map<string, WorktreeThreadState>();
    for (const row of rows) {
      const resolved = path.resolve(row.worktreePath);
      workspaceByPath.set(resolved, row.workspaceRoot);
      const state = row.state as WorktreeThreadState;
      // A path shared by several threads is only orphaned when none is active.
      if (stateByPath.get(resolved) !== "active") stateByPath.set(resolved, state);
    }
    const candidates: WorktreeCandidate[] = [];
    for (const [worktreePath, threadState] of stateByPath) {
      if (threadState === "active") {
        candidates.push({
          worktreePath,
          threadState,
          hasUncommittedChanges: null,
          hasUnpushedCommits: null,
          isLinkedWorktree: false,
        });
        continue;
      }
      if (!(yield* fs.exists(worktreePath).pipe(Effect.orElseSucceed(() => false)))) continue;
      const isLinkedWorktree = yield* fs.stat(path.join(worktreePath, ".git")).pipe(
        Effect.map((stat) => stat.type === "File"),
        Effect.orElseSucceed(() => false),
      );
      if (!isLinkedWorktree) {
        candidates.push({
          worktreePath,
          threadState,
          hasUncommittedChanges: null,
          hasUnpushedCommits: null,
          isLinkedWorktree,
        });
        continue;
      }
      const status = yield* git
        .statusDetailsLocal(worktreePath, { includeDivergence: true })
        .pipe(Effect.orElseSucceed(() => null));
      candidates.push({
        worktreePath,
        threadState,
        hasUncommittedChanges: status === null ? null : status.hasWorkingTreeChanges,
        hasUnpushedCommits:
          status === null
            ? null
            : status.hasUpstream
              ? status.aheadCount > 0
              : status.aheadOfDefaultCount > 0,
        isLinkedWorktree,
      });
    }
    return { candidates, workspaceByPath };
  });

  const collectLogFiles = Effect.fn("ServerHousekeeping.collectLogFiles")(function* (
    directory: string,
    into: LogFileCandidate[],
  ): Effect.fn.Return<void, ServerHousekeepingError> {
    for (const name of yield* fs
      .readDirectory(directory)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ServerHousekeepingError({ operation: "list-logs", path: directory, cause }),
        ),
      )) {
      const target = path.join(directory, name);
      const stat = yield* fs
        .stat(target)
        .pipe(
          Effect.mapError(
            (cause) => new ServerHousekeepingError({ operation: "list-logs", path: target, cause }),
          ),
        );
      if (stat.type === "Directory") {
        yield* collectLogFiles(target, into);
      } else if (stat.type === "File" && stat.mtime._tag === "Some") {
        into.push({ path: target, modifiedAtMs: stat.mtime.value.getTime() });
      }
    }
  });

  const runNowImpl = Effect.fn("ServerHousekeeping.runNow")(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ServerHousekeepingError({
            operation: "list-worktrees",
            path: config.settingsPath,
            cause,
          }),
      ),
    );
    const now = yield* Clock.currentTimeMillis;

    const { candidates, workspaceByPath } = yield* listCandidates();
    const plan = planWorktreeCleanup(candidates);
    const removedWorktrees: string[] = [];
    const keptWorktrees: PlannedWorktreeKeep[] = [...plan.keep];
    for (const worktreePath of plan.remove) {
      const workspaceRoot = workspaceByPath.get(worktreePath);
      // `git worktree remove` without force refuses dirty worktrees itself,
      // so a change landing after our status check still cannot be deleted.
      const removed = yield* workspaceRoot === undefined
        ? Effect.succeed(false)
        : git.removeWorktree({ cwd: workspaceRoot, path: worktreePath }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
      if (removed) {
        removedWorktrees.push(worktreePath);
        yield* Effect.logInfo("Housekeeping removed orphaned worktree", { worktreePath });
      } else {
        keptWorktrees.push({ worktreePath, reason: "git worktree remove failed" });
        yield* Effect.logWarning("Housekeeping skipped worktree removal", { worktreePath });
      }
    }
    for (const kept of plan.keep) {
      yield* Effect.logInfo("Housekeeping kept worktree", {
        worktreePath: kept.worktreePath,
        reason: kept.reason,
      });
    }

    let removedLogFiles = 0;
    if (yield* fs.exists(config.logsDir).pipe(Effect.orElseSucceed(() => false))) {
      const files: LogFileCandidate[] = [];
      yield* collectLogFiles(config.logsDir, files);
      const logPlan = planLogPruning(
        files,
        now,
        settings.storageCleanup.logsAfterDays ?? DEFAULT_LOG_RETENTION_DAYS,
      );
      for (const filePath of logPlan.remove) {
        yield* fs.remove(filePath).pipe(Effect.orElseSucceed(() => undefined));
        removedLogFiles++;
      }
    }

    const vacuum = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`.pipe(
      Effect.mapError(
        (cause) =>
          new ServerHousekeepingError({ operation: "database", path: config.dbPath, cause }),
      ),
    );
    const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`.pipe(
      Effect.mapError(
        (cause) =>
          new ServerHousekeepingError({ operation: "database", path: config.dbPath, cause }),
      ),
    );
    const dbPlan = planDatabaseMaintenance({
      incrementalVacuumEnabled: vacuum[0]?.auto_vacuum === 2,
      freelistCount: free[0]?.freelist_count ?? 0,
    });
    if (dbPlan.runOptimize) {
      yield* sql`PRAGMA optimize = 0x10002`.pipe(
        Effect.mapError(
          (cause) =>
            new ServerHousekeepingError({ operation: "database", path: config.dbPath, cause }),
        ),
      );
    }
    if (dbPlan.runIncrementalVacuum) {
      yield* Effect.gen(function* () {
        for (let page = 0; page < VACUUM_PAGES_PER_PASS; page++) {
          const remaining = yield* sql<{
            readonly freelist_count: number;
          }>`PRAGMA freelist_count`;
          if ((remaining[0]?.freelist_count ?? 0) === 0) break;
          yield* sql`PRAGMA incremental_vacuum(1)`;
          yield* Effect.yieldNow;
        }
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ServerHousekeepingError({ operation: "database", path: config.dbPath, cause }),
        ),
      );
    }

    const report: HousekeepingReport = {
      removedWorktrees,
      keptWorktrees,
      removedLogFiles,
      databaseOptimizeRun: dbPlan.runOptimize,
      databaseVacuumRun: dbPlan.runIncrementalVacuum,
    };
    yield* Effect.logInfo("Housekeeping pass finished", {
      removedWorktrees: removedWorktrees.length,
      keptWorktrees: keptWorktrees.length,
      removedLogFiles,
    });
    return report;
  });

  const runNow = runNowImpl();

  const scheduledRun = runNow.pipe(
    Effect.catch((cause) => Effect.logWarning("Housekeeping pass failed", { cause })),
    Effect.asVoid,
  );
  yield* forkParked(
    Effect.sleep("1 minute").pipe(
      Effect.andThen(scheduledRun),
      Effect.andThen(Effect.sleep("6 hours")),
      Effect.forever,
    ),
  );

  return ServerHousekeeping.of({ runNow });
});

export const layer = Layer.effect(ServerHousekeeping, make);

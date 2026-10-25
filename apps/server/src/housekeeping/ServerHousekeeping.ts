/**
 * ServerHousekeeping - Built-in periodic cleanup owned by the server.
 *
 * No cron, no scheduled agent task, no provider turn. Each run:
 * - prunes log files older than `storageCleanup.logsAfterDays`, only when the
 *   configured retention allows it, and only files that really live under the logs directory;
 * - runs `PRAGMA optimize` and, when incremental auto_vacuum is on and free
 *   pages exist, a bounded `PRAGMA incremental_vacuum`.
 *
 * Worktrees are left to StorageCleanup, which follows the user's cleanup
 * rules: removing them here deleted git-ignored files such as `.env` from
 * threads that were only archived.
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

const DAY_MS = 86_400_000;
/** Free pages returned per housekeeping pass; matches DatabaseStorage. */
const VACUUM_PAGES_PER_PASS = 1024;

export class ServerHousekeepingError extends Schema.TaggedError<ServerHousekeepingError>()(
  "ServerHousekeepingError",
  {
    operation: Schema.Literals(["settings", "list-logs", "database"]),
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
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // A symlink under logs/ must not lead the pruner to files elsewhere.
  const insideLogs = (logsRoot: string, target: string) =>
    fs.realPath(target).pipe(
      Effect.map((real) => real === logsRoot || real.startsWith(`${logsRoot}${path.sep}`)),
      Effect.orElseSucceed(() => false),
    );

  const collectLogFiles = Effect.fn("ServerHousekeeping.collectLogFiles")(function* (
    logsRoot: string,
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
      if (!(yield* insideLogs(logsRoot, target))) continue;
      const stat = yield* fs
        .stat(target)
        .pipe(
          Effect.mapError(
            (cause) => new ServerHousekeepingError({ operation: "list-logs", path: target, cause }),
          ),
        );
      if (stat.type === "Directory") {
        yield* collectLogFiles(logsRoot, target, into);
      } else if (
        stat.type === "File" &&
        stat.mtime._tag === "Some" &&
        /\.(?:log|ndjson)\.\d+$/.test(name)
      ) {
        into.push({ path: target, modifiedAtMs: stat.mtime.value.getTime() });
      }
    }
  });

  const runNowImpl = Effect.fn("ServerHousekeeping.runNow")(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ServerHousekeepingError({
            operation: "settings",
            path: config.settingsPath,
            cause,
          }),
      ),
    );
    const now = yield* Clock.currentTimeMillis;

    let removedLogFiles = 0;
    const logsAfterDays = settings.storageCleanup.logsAfterDays;
    if (
      logsAfterDays !== null &&
      (yield* fs.exists(config.logsDir).pipe(Effect.orElseSucceed(() => false)))
    ) {
      const logsRoot = yield* fs
        .realPath(config.logsDir)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ServerHousekeepingError({ operation: "list-logs", path: config.logsDir, cause }),
          ),
        );
      const files: LogFileCandidate[] = [];
      yield* collectLogFiles(logsRoot, logsRoot, files);
      const logPlan = planLogPruning(files, now, logsAfterDays);
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
      removedLogFiles,
      databaseOptimizeRun: dbPlan.runOptimize,
      databaseVacuumRun: dbPlan.runIncrementalVacuum,
    };
    yield* Effect.logInfo("Housekeeping pass finished", { removedLogFiles });
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

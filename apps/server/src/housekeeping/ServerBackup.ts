/**
 * ServerBackup - Built-in nightly backups of the Cogenly home.
 *
 * The server owns this job: no cron, no scheduled agent task, no provider
 * turn. Each run writes one directory `<home>/backups/<timestamp>/` holding a
 * consistent SQLite snapshot (online backup API, via `backupDatabase`), the
 * settings file, and the secrets directory. Backup directories are `0700`
 * and files `0600` because they contain secrets. The newest
 * `automaticBackups.retentionCount` directories are kept.
 *
 * `backupNow` is the service method an agent or transport can trigger later
 * ("back up now"); the periodic fiber only calls it when a backup is due and
 * the `automaticBackups` setting is enabled.
 *
 * @module ServerBackup
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { backupDatabase } from "../persistence/DatabaseBackup.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";

/** How often the parked fiber re-checks whether a nightly backup is due. */
const BACKUP_CHECK_INTERVAL = "1 hour";
/** A backup is due when the newest one is at least this old. */
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const BACKUP_DIRECTORY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/;

export class ServerBackupError extends Schema.TaggedError<ServerBackupError>()(
  "ServerBackupError",
  {
    operation: Schema.Literals(["snapshot", "copy", "prune", "list"]),
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Server backup ${this.operation} failed at ${this.path}.`;
  }
}

export const isServerBackupError = Schema.is(ServerBackupError);

export interface BackupRunResult {
  readonly directory: string;
  readonly pruned: ReadonlyArray<string>;
}

/** Directory name for a backup taken at `now`; sorts chronologically. */
export const backupDirectoryName = (now: Date): string => now.toISOString().replaceAll(":", "-");

/**
 * Pure retention plan: of the given entry names in the backups directory,
 * which backup directories to keep and which to remove so only the newest
 * `keep` remain. Entries that do not look like backup directories are always
 * kept and never counted.
 */
export const planBackupRetention = (
  names: ReadonlyArray<string>,
  keep: number,
): { readonly keep: ReadonlyArray<string>; readonly remove: ReadonlyArray<string> } => {
  const backups = names.filter((name) => BACKUP_DIRECTORY_PATTERN.test(name)).toSorted();
  const other = names.filter((name) => !BACKUP_DIRECTORY_PATTERN.test(name));
  const removeCount = Math.max(0, backups.length - Math.max(0, keep));
  return {
    keep: [...other, ...backups.slice(removeCount)],
    remove: backups.slice(0, removeCount),
  };
};

/** Pure due check: no backup yet, or the newest is older than the interval. */
export const isBackupDue = (
  latestBackupAtMs: number | null,
  nowMs: number,
  intervalMs: number = BACKUP_INTERVAL_MS,
): boolean => latestBackupAtMs === null || nowMs - latestBackupAtMs >= intervalMs;

export class ServerBackup extends Context.Service<
  ServerBackup,
  {
    /** Back up now, regardless of the automatic schedule. Returns the new directory and what retention pruned. */
    readonly backupNow: Effect.Effect<BackupRunResult, ServerBackupError>;
  }
>()("cogenly-server/housekeeping/ServerBackup") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const backupsDirectory = path.join(config.baseDir, "backups");

  const copyTreePrivate = Effect.fn("ServerBackup.copyTreePrivate")(function* (
    source: string,
    destination: string,
  ): Effect.fn.Return<void, ServerBackupError> {
    yield* fs
      .makeDirectory(destination, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError(
          (cause) => new ServerBackupError({ operation: "copy", path: destination, cause }),
        ),
      );
    yield* fs.chmod(destination, 0o700).pipe(Effect.orElseSucceed(() => undefined));
    for (const name of yield* fs
      .readDirectory(source)
      .pipe(
        Effect.mapError(
          (cause) => new ServerBackupError({ operation: "copy", path: source, cause }),
        ),
      )) {
      const from = path.join(source, name);
      const to = path.join(destination, name);
      const stat = yield* fs
        .stat(from)
        .pipe(
          Effect.mapError(
            (cause) => new ServerBackupError({ operation: "copy", path: from, cause }),
          ),
        );
      if (stat.type === "Directory") {
        yield* copyTreePrivate(from, to);
      } else if (stat.type === "File") {
        const bytes = yield* fs
          .readFile(from)
          .pipe(
            Effect.mapError(
              (cause) => new ServerBackupError({ operation: "copy", path: from, cause }),
            ),
          );
        yield* fs
          .writeFile(to, bytes)
          .pipe(
            Effect.mapError(
              (cause) => new ServerBackupError({ operation: "copy", path: to, cause }),
            ),
          );
        yield* fs.chmod(to, 0o600).pipe(Effect.orElseSucceed(() => undefined));
      }
    }
  });

  const pruneOldBackups = Effect.fn("ServerBackup.pruneOldBackups")(function* (
    keep: number,
  ): Effect.fn.Return<ReadonlyArray<string>, ServerBackupError> {
    if (!(yield* fs.exists(backupsDirectory))) return [];
    const names = yield* fs
      .readDirectory(backupsDirectory)
      .pipe(
        Effect.mapError(
          (cause) => new ServerBackupError({ operation: "list", path: backupsDirectory, cause }),
        ),
      );
    const plan = planBackupRetention(names, keep);
    for (const name of plan.remove) {
      yield* fs.remove(path.join(backupsDirectory, name), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ServerBackupError({
              operation: "prune",
              path: path.join(backupsDirectory, name),
              cause,
            }),
        ),
      );
    }
    return plan.remove;
  });

  const backupNow = Effect.fn("ServerBackup.backupNow")(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        (cause) => new ServerBackupError({ operation: "list", path: config.settingsPath, cause }),
      ),
    );
    const directory = path.join(
      backupsDirectory,
      backupDirectoryName(new Date(yield* Clock.currentTimeMillis)),
    );
    yield* fs
      .makeDirectory(directory, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError(
          (cause) => new ServerBackupError({ operation: "copy", path: directory, cause }),
        ),
      );
    yield* fs.chmod(directory, 0o700).pipe(Effect.orElseSucceed(() => undefined));

    const snapshotPath = path.join(directory, "statev2.sqlite");
    yield* backupDatabase({ dbPath: config.dbPath, outPath: snapshotPath }).pipe(
      Effect.mapError(
        (cause) => new ServerBackupError({ operation: "snapshot", path: snapshotPath, cause }),
      ),
    );
    yield* fs.chmod(snapshotPath, 0o600).pipe(Effect.orElseSucceed(() => undefined));

    if (yield* fs.exists(config.settingsPath)) {
      const settingsCopy = path.join(directory, "settings.json");
      const bytes = yield* fs
        .readFile(config.settingsPath)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ServerBackupError({ operation: "copy", path: config.settingsPath, cause }),
          ),
        );
      yield* fs
        .writeFile(settingsCopy, bytes)
        .pipe(
          Effect.mapError(
            (cause) => new ServerBackupError({ operation: "copy", path: settingsCopy, cause }),
          ),
        );
      yield* fs.chmod(settingsCopy, 0o600).pipe(Effect.orElseSucceed(() => undefined));
    }

    if (yield* fs.exists(config.secretsDir)) {
      yield* copyTreePrivate(config.secretsDir, path.join(directory, "secrets"));
    }

    const pruned = yield* pruneOldBackups(settings.automaticBackups.retentionCount);
    yield* Effect.logInfo("Server backup written", { directory, pruned: pruned.length });
    return { directory, pruned } satisfies BackupRunResult;
  });

  const latestBackupAt = Effect.gen(function* () {
    if (!(yield* fs.exists(backupsDirectory))) return null;
    const names = yield* fs.readDirectory(backupsDirectory);
    const backups = names.filter((name) => BACKUP_DIRECTORY_PATTERN.test(name)).toSorted();
    const latest = backups.at(-1);
    if (latest === undefined) return null;
    const stat = yield* fs.stat(path.join(backupsDirectory, latest));
    return stat.mtime._tag === "Some" ? stat.mtime.value.getTime() : null;
  }).pipe(Effect.orElseSucceed(() => null));

  const backupIfDue = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
    if (!settings.automaticBackups.enabled) return;
    const now = yield* Clock.currentTimeMillis;
    if (!isBackupDue(yield* latestBackupAt, now)) return;
    yield* backupNow().pipe(
      Effect.catch((cause) => Effect.logWarning("Nightly server backup failed", { cause })),
    );
  });

  // First check a minute after startup, like DatabaseStorage: a backup is
  // never urgent in the first minute, and startup stays out of its way.
  yield* forkParked(
    Effect.sleep("1 minute").pipe(
      Effect.andThen(
        backupIfDue.pipe(Effect.repeat(Schedule.spaced(BACKUP_CHECK_INTERVAL)), Effect.asVoid),
      ),
    ),
  );

  return ServerBackup.of({ backupNow });
});

export const layer = Layer.effect(ServerBackup, make);

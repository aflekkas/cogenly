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
import * as DateTime from "effect/DateTime";
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
export const backupDirectoryName = (now: DateTime.Utc): string =>
  DateTime.formatIso(now).replaceAll(":", "-");

/**
 * Pure retention plan: of the given entries in the backups directory, which
 * backup directories to keep and which to remove so only the newest `keep`
 * complete backups remain. Only a dated folder holding a `statev2.sqlite`
 * snapshot counts as a backup; a dated folder without one is the remains of
 * a failed backup and is removed, and entries that do not look like backup
 * directories are always kept and never counted.
 */
export const planBackupRetention = (
  entries: ReadonlyArray<{ readonly name: string; readonly hasSnapshot: boolean }>,
  keep: number,
): { readonly keep: ReadonlyArray<string>; readonly remove: ReadonlyArray<string> } => {
  const backups = entries
    .filter((entry) => entry.hasSnapshot && BACKUP_DIRECTORY_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .toSorted();
  const incomplete = entries
    .filter((entry) => !entry.hasSnapshot && BACKUP_DIRECTORY_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .toSorted();
  const other = entries
    .filter((entry) => !BACKUP_DIRECTORY_PATTERN.test(entry.name))
    .map((entry) => entry.name);
  const removeCount = Math.max(0, backups.length - Math.max(0, keep));
  return {
    keep: [...other, ...backups.slice(removeCount)],
    remove: [...backups.slice(0, removeCount), ...incomplete],
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
    if (!(yield* fs.exists(backupsDirectory).pipe(Effect.orElseSucceed(() => false)))) return [];
    const names = yield* fs
      .readDirectory(backupsDirectory)
      .pipe(
        Effect.mapError(
          (cause) => new ServerBackupError({ operation: "list", path: backupsDirectory, cause }),
        ),
      );
    const entries = yield* Effect.forEach(names, (name) =>
      fs.exists(path.join(backupsDirectory, name, "statev2.sqlite")).pipe(
        Effect.map((hasSnapshot) => ({ name, hasSnapshot })),
        Effect.orElseSucceed(() => ({ name, hasSnapshot: false })),
      ),
    );
    const plan = planBackupRetention(entries, keep);
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

  const backupNowImpl = Effect.fn("ServerBackup.backupNow")(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        (cause) => new ServerBackupError({ operation: "list", path: config.settingsPath, cause }),
      ),
    );
    const directory = path.join(backupsDirectory, backupDirectoryName(yield* DateTime.now));
    // Write under a temp name and rename on success: a failed backup must
    // not leave an empty dated folder that counts as the newest backup.
    // The leading dot keeps the temp name out of the dated-folder pattern.
    const tempDirectory = path.join(
      backupsDirectory,
      `.tmp-${backupDirectoryName(yield* DateTime.now)}-${Math.random().toString(36).slice(2, 10)}`,
    );
    yield* fs
      .makeDirectory(backupsDirectory, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError(
          (cause) => new ServerBackupError({ operation: "copy", path: backupsDirectory, cause }),
        ),
      );
    yield* fs
      .makeDirectory(tempDirectory, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError(
          (cause) => new ServerBackupError({ operation: "copy", path: tempDirectory, cause }),
        ),
      );
    yield* fs.chmod(tempDirectory, 0o700).pipe(Effect.orElseSucceed(() => undefined));

    const writeBackup = Effect.gen(function* () {
      const snapshotPath = path.join(tempDirectory, "statev2.sqlite");
      yield* backupDatabase({ dbPath: config.dbPath, outPath: snapshotPath }).pipe(
        Effect.mapError(
          (cause) => new ServerBackupError({ operation: "snapshot", path: snapshotPath, cause }),
        ),
      );
      yield* fs.chmod(snapshotPath, 0o600).pipe(Effect.orElseSucceed(() => undefined));

      if (yield* fs.exists(config.settingsPath).pipe(Effect.orElseSucceed(() => false))) {
        const settingsCopy = path.join(tempDirectory, "settings.json");
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

      if (yield* fs.exists(config.secretsDir).pipe(Effect.orElseSucceed(() => false))) {
        yield* copyTreePrivate(config.secretsDir, path.join(tempDirectory, "secrets"));
      }

      yield* fs
        .rename(tempDirectory, directory)
        .pipe(
          Effect.mapError(
            (cause) => new ServerBackupError({ operation: "copy", path: directory, cause }),
          ),
        );

      const pruned = yield* pruneOldBackups(settings.automaticBackups.retentionCount);
      yield* Effect.logInfo("Server backup written", { directory, pruned: pruned.length });
      return { directory, pruned } satisfies BackupRunResult;
    });
    // A failed backup removes its temp folder; the rename above already
    // moved a successful one, so this only ever deletes a partial write.
    return yield* writeBackup.pipe(
      Effect.onError(() => fs.remove(tempDirectory, { recursive: true }).pipe(Effect.ignore)),
    );
  });

  // `backupDatabase` reads FileSystem/Path from the environment; bind the
  // instances this layer was built with so callers need neither.
  const backupNow = backupNowImpl().pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );

  const latestBackupAt = Effect.gen(function* () {
    if (!(yield* fs.exists(backupsDirectory))) return null;
    const names = yield* fs.readDirectory(backupsDirectory);
    // Only a folder holding a snapshot counts; a failed backup's remains
    // must not make the nightly backup look fresh.
    const backups = names.filter((name) => BACKUP_DIRECTORY_PATTERN.test(name)).toSorted();
    for (const name of backups.toReversed()) {
      if (!(yield* fs.exists(path.join(backupsDirectory, name, "statev2.sqlite")))) continue;
      const stat = yield* fs.stat(path.join(backupsDirectory, name));
      return stat.mtime._tag === "Some" ? stat.mtime.value.getTime() : null;
    }
    return null;
  }).pipe(Effect.orElseSucceed(() => null));

  const backupIfDue = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
    if (!settings.automaticBackups.enabled) return;
    const now = yield* Clock.currentTimeMillis;
    if (!isBackupDue(yield* latestBackupAt, now)) return;
    yield* backupNow.pipe(
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

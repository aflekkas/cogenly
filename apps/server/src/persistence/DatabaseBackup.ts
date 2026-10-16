/**
 * DatabaseBackup - Consistent offline snapshots of the state database.
 *
 * The SQLite online backup API copies through a read-only handle, so the
 * snapshot is consistent even while the server runs — no shutdown needed.
 * The snapshot lands under a temporary name first and is renamed into place,
 * so an interrupted backup never leaves a partial file behind.
 *
 * @module DatabaseBackup
 */
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const BACKUP_FILE_PREFIX = "cogenly-backup-";
export const BACKUP_FILE_SUFFIX = ".sqlite";

export class DatabaseBackupError extends Schema.TaggedError<DatabaseBackupError>()(
  "DatabaseBackupError",
  {
    dbPath: Schema.String,
    outPath: Schema.String,
    reason: Schema.Literals(["not-found", "failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "not-found"
      ? `No state database at ${this.dbPath}; nothing to back up.`
      : `Could not back up ${this.dbPath} to ${this.outPath}.`;
  }
}

export const backupDatabase = Effect.fn("backupDatabase")(function* (input: {
  readonly dbPath: string;
  readonly outPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(input.dbPath))) {
    return yield* new DatabaseBackupError({
      dbPath: input.dbPath,
      outPath: input.outPath,
      reason: "not-found",
    });
  }
  const directory = path.dirname(input.outPath);
  yield* fs.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DatabaseBackupError({
          dbPath: input.dbPath,
          outPath: input.outPath,
          reason: "failed",
          cause,
        }),
    ),
  );
  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
        directory,
        prefix: ".backup-",
      });
      const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
      yield* Effect.tryPromise({
        try: async () => {
          const database = new NodeSqlite.DatabaseSync(input.dbPath, { readOnly: true });
          try {
            await NodeSqlite.backup(database, snapshotPath);
          } finally {
            database.close();
          }
        },
        catch: (cause) =>
          new DatabaseBackupError({
            dbPath: input.dbPath,
            outPath: input.outPath,
            reason: "failed",
            cause,
          }),
      });
      yield* fs.rename(snapshotPath, input.outPath).pipe(
        Effect.mapError(
          (cause) =>
            new DatabaseBackupError({
              dbPath: input.dbPath,
              outPath: input.outPath,
              reason: "failed",
              cause,
            }),
        ),
      );
    }),
  );
  return input.outPath;
});

/**
 * Remove timestamped backups beyond the newest `keep` in `directory`.
 * Names sort chronologically, so the oldest sort first. Returns the removed
 * file names. Only touches `${BACKUP_FILE_PREFIX}*${BACKUP_FILE_SUFFIX}`.
 */
export const pruneBackups = Effect.fn("pruneBackups")(function* (input: {
  readonly directory: string;
  readonly keep: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(input.directory))) return [];
  const entries = yield* fs.readDirectory(input.directory);
  const matches = entries
    .filter((entry) => entry.startsWith(BACKUP_FILE_PREFIX) && entry.endsWith(BACKUP_FILE_SUFFIX))
    .toSorted();
  const stale = matches.slice(0, Math.max(0, matches.length - input.keep));
  for (const name of stale) {
    yield* fs.remove(path.join(input.directory, name));
  }
  return stale;
});

import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  backupDatabase,
  DatabaseBackupError,
  pruneBackups,
  BACKUP_FILE_PREFIX,
  BACKUP_FILE_SUFFIX,
} from "./DatabaseBackup.ts";

const seedDatabase = (dbPath: string) => {
  const database = new NodeSqlite.DatabaseSync(dbPath);
  try {
    database.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL);");
    database.exec("INSERT INTO notes (text) VALUES ('first'), ('second');");
  } finally {
    database.close();
  }
};

const readSnapshot = (
  snapshotPath: string,
): { readonly texts: Array<string>; readonly ok: boolean } => {
  const database = new NodeSqlite.DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const rows = database.prepare("SELECT text FROM notes ORDER BY id;").all() as Array<{
      text: string;
    }>;
    const integrity = database.prepare("PRAGMA integrity_check;").all() as Array<{
      integrity_check: string;
    }>;
    return {
      texts: rows.map((row) => row.text),
      ok: integrity.length === 1 && integrity[0]?.integrity_check === "ok",
    };
  } finally {
    database.close();
  }
};

describe("database backup", () => {
  it.effect("writes a consistent snapshot of a live database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-backup-test-" });
      const dbPath = path.join(root, "statev2.sqlite");
      seedDatabase(dbPath);
      const outPath = path.join(root, "backups", "snapshot.sqlite");
      expect(yield* backupDatabase({ dbPath, outPath })).toBe(outPath);
      expect(readSnapshot(outPath)).toEqual({ texts: ["first", "second"], ok: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a missing database with a typed error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-backup-missing-" });
      const error = yield* backupDatabase({
        dbPath: path.join(root, "absent.sqlite"),
        outPath: path.join(root, "out.sqlite"),
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(DatabaseBackupError);
      expect(error.reason).toBe("not-found");
      expect(yield* fs.exists(path.join(root, "out.sqlite"))).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("prunes timestamped backups to the newest keep", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-backup-prune-" });
      const names = [
        `${BACKUP_FILE_PREFIX}2026-10-13T02-00-00.000Z${BACKUP_FILE_SUFFIX}`,
        `${BACKUP_FILE_PREFIX}2026-10-14T02-00-00.000Z${BACKUP_FILE_SUFFIX}`,
        `${BACKUP_FILE_PREFIX}2026-10-15T02-00-00.000Z${BACKUP_FILE_SUFFIX}`,
        "unrelated.sqlite",
      ];
      for (const name of names) {
        yield* fs.writeFileString(path.join(directory, name), "x");
      }
      const removed = yield* pruneBackups({ directory, keep: 2 });
      expect(removed).toEqual([
        `${BACKUP_FILE_PREFIX}2026-10-13T02-00-00.000Z${BACKUP_FILE_SUFFIX}`,
      ]);
      expect(yield* fs.readDirectory(directory)).toEqual(
        expect.arrayContaining([
          `${BACKUP_FILE_PREFIX}2026-10-14T02-00-00.000Z${BACKUP_FILE_SUFFIX}`,
          `${BACKUP_FILE_PREFIX}2026-10-15T02-00-00.000Z${BACKUP_FILE_SUFFIX}`,
          "unrelated.sqlite",
        ]),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

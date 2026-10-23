// @effect-diagnostics nodeBuiltinImport:off - tests assert real file modes and read snapshots directly.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  backupDirectoryName,
  isBackupDue,
  planBackupRetention,
  ServerBackup,
  layer,
} from "./ServerBackup.ts";

describe("planBackupRetention", () => {
  it("keeps the newest N backup directories and removes the rest", () => {
    const plan = planBackupRetention(
      [
        "2026-10-11T02-00-00.000Z",
        "2026-10-13T02-00-00.000Z",
        "2026-10-12T02-00-00.000Z",
        "unrelated-dir",
      ],
      2,
    );
    expect(plan.remove).toEqual(["2026-10-11T02-00-00.000Z"]);
    expect(plan.keep).toEqual(
      expect.arrayContaining([
        "2026-10-12T02-00-00.000Z",
        "2026-10-13T02-00-00.000Z",
        "unrelated-dir",
      ]),
    );
  });

  it("removes nothing when at or under the retention count", () => {
    expect(planBackupRetention(["2026-10-13T02-00-00.000Z"], 7).remove).toEqual([]);
    expect(planBackupRetention([], 7)).toEqual({ keep: [], remove: [] });
  });

  it("treats keep=1 as only the newest backup", () => {
    const plan = planBackupRetention(["2026-10-11T02-00-00.000Z", "2026-10-12T02-00-00.000Z"], 1);
    expect(plan.remove).toEqual(["2026-10-11T02-00-00.000Z"]);
    expect(plan.keep).toEqual(["2026-10-12T02-00-00.000Z"]);
  });
});

describe("isBackupDue", () => {
  it("is due with no previous backup or an old one, not with a fresh one", () => {
    const now = 1_000_000_000_000;
    expect(isBackupDue(null, now)).toBe(true);
    expect(isBackupDue(now - 25 * 60 * 60 * 1_000, now)).toBe(true);
    expect(isBackupDue(now - 60 * 60 * 1_000, now)).toBe(false);
  });
});

describe("backupDirectoryName", () => {
  it("sorts chronologically as plain text", () => {
    const earlier = backupDirectoryName(DateTime.makeUnsafe("2026-10-11T02:00:00.000Z"));
    const later = backupDirectoryName(DateTime.makeUnsafe("2026-10-12T02:00:00.000Z"));
    expect(earlier < later).toBe(true);
  });
});

const seedDatabase = (dbPath: string) => {
  const database = new NodeSqlite.DatabaseSync(dbPath);
  try {
    database.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL);");
    database.exec("INSERT INTO notes (text) VALUES ('alpha'), ('beta');");
  } finally {
    database.close();
  }
};

// Automatic runs are off here so the parked nightly fiber cannot race the
// manual `backupNow` under test; `backupNow` itself ignores `enabled`.
const testLayer = layer.pipe(
  Layer.provide(
    ServerSettings.layerTest({ automaticBackups: { enabled: false, retentionCount: 2 } }),
  ),
  Layer.provideMerge(ServerConfig.layerTest("/tmp", { prefix: "cogenly-backup-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

describe("ServerBackup.backupNow", () => {
  it.effect("writes a private, readable backup of db, settings and secrets, then prunes", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      seedDatabase(config.dbPath);
      yield* fs.writeFileString(config.settingsPath, `{"theme":"dark"}`);
      yield* fs.makeDirectory(config.secretsDir, { recursive: true });
      yield* fs.writeFileString(path.join(config.secretsDir, "token.bin"), "secret-bytes");

      // Two older backups; retention 2 must keep the newest old one plus the new backup.
      const backupsDir = path.join(config.baseDir, "backups");
      for (const name of ["2026-10-10T02-00-00.000Z", "2026-10-11T02-00-00.000Z"]) {
        yield* fs.makeDirectory(path.join(backupsDir, name), { recursive: true });
      }

      const backup = yield* ServerBackup;
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-12T02:00:00.000Z")),
      );
      const result = yield* backup.backupNow;

      expect(result.directory.startsWith(backupsDir)).toBe(true);
      expect(result.pruned).toEqual(["2026-10-10T02-00-00.000Z"]);
      expect(NodeFS.existsSync(path.join(backupsDir, "2026-10-11T02-00-00.000Z"))).toBe(true);

      const snapshot = new NodeSqlite.DatabaseSync(path.join(result.directory, "statev2.sqlite"), {
        readOnly: true,
      });
      try {
        const rows = snapshot.prepare("SELECT text FROM notes ORDER BY id;").all() as Array<{
          text: string;
        }>;
        expect(rows.map((row) => row.text)).toEqual(["alpha", "beta"]);
        const integrity = snapshot.prepare("PRAGMA integrity_check;").all() as Array<{
          integrity_check: string;
        }>;
        expect(integrity[0]?.integrity_check).toBe("ok");
      } finally {
        snapshot.close();
      }

      expect(NodeFS.readFileSync(path.join(result.directory, "settings.json"), "utf8")).toBe(
        `{"theme":"dark"}`,
      );
      expect(NodeFS.readFileSync(path.join(result.directory, "secrets", "token.bin"), "utf8")).toBe(
        "secret-bytes",
      );

      expect(NodeFS.statSync(result.directory).mode & 0o777).toBe(0o700);
      expect(NodeFS.statSync(path.join(result.directory, "statev2.sqlite")).mode & 0o777).toBe(
        0o600,
      );
      expect(NodeFS.statSync(path.join(result.directory, "settings.json")).mode & 0o777).toBe(
        0o600,
      );
      expect(NodeFS.statSync(path.join(result.directory, "secrets")).mode & 0o777).toBe(0o700);
      expect(
        NodeFS.statSync(path.join(result.directory, "secrets", "token.bin")).mode & 0o777,
      ).toBe(0o600);
    }).pipe(Effect.provide(testLayer)),
  );
});

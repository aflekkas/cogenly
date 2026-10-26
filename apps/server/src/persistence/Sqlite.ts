import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@cogenly/shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as ServerConfig from "../config.ts";

// Size the -wal file is cut back to on the first commit after a WAL reset.
export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

const layerSetup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Only an empty file can switch modes here; an existing database needs the
    // offline VACUUM that `cogenly doctor` runs, which rebuilds it with pointer maps.
    const tables = yield* sql<{
      readonly count: number;
    }>`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'`;
    if (tables[0]?.count === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* runMigrations();
    // Without sqlite_stat1 the planner guesses at index selectivity. 0x10012
    // analyzes tables whose indexes lack stats or whose row count changed 10x,
    // under a temporary analysis_limit. Otherwise it only checks table sizes.
    yield* sql`PRAGMA optimize = 0x10012;`;
  }),
);

export const layerFromPath = Effect.fn("makeSqlitePersistenceLive")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    layerSetup,
    NodeSqliteClient.layer({
      filename: dbPath,
      readerWorker: true,
      writerWorker: true,
      // These settings are connection-local: initialize the main-thread fallback
      // and every replacement writer, not just the worker that runs migrations.
      connectionPragmas: [
        "PRAGMA foreign_keys = ON",
        // NORMAL fsyncs at checkpoints. An app crash loses nothing; an OS crash
        // or power loss can roll back commits since the last checkpoint.
        "PRAGMA synchronous = NORMAL",
        // F_FULLFSYNC flushes the macOS drive cache; other platforms ignore it.
        "PRAGMA checkpoint_fullfsync = ON",
        `PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`,
      ],
      // Checkpoints sync the database, with F_FULLFSYNC on macOS. Run them off
      // the event loop so a slow flush cannot stall clients.
      checkpointWorker: true,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "cogenly-server",
      },
    }),
  );
}, Layer.unwrap);

export const layerMemory = Layer.provideMerge(
  layerSetup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    yield* initializeV2Database(dbPath);
    return layerFromPath(dbPath);
  }),
);

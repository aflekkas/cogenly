import * as SqlitePersistence from "./Sqlite.ts";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@cogenly/shared/nodeSqliteClient";

const database = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-sqlite-concurrency-" });
  const filename = `${root}/test.sqlite`;
  const external = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (db) => Effect.sync(() => db.close()),
  );
  external.exec(
    "PRAGMA journal_mode = WAL; CREATE TABLE items (value INTEGER); INSERT INTO items VALUES (0);",
  );
  const context = yield* Layer.build(
    NodeSqliteClient.layer({
      filename,
      readerWorker: true,
      writerWorker: true,
      checkpointWorker: true,
    }),
  );
  return { sql: Context.get(context, SqlClient.SqlClient), external };
});

it.live("reader queries finish while a writer transaction owns its connection", () =>
  Effect.gen(function* () {
    const { sql } = yield* database;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const writing = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE items SET value = 1`;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const rows = yield* sql
      .withTransaction(sql<{ value: number }>`SELECT value FROM items`)
      .pipe(NodeSqliteClient.readOnly);
    expect(rows[0]?.value).toBe(0);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(writing);
    expect(
      (yield* sql<{ value: number }>`SELECT value FROM items`.pipe(NodeSqliteClient.readOnly))[0]
        ?.value,
    ).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("writer lock waits leave the main event loop free and retry after release", () =>
  Effect.gen(function* () {
    const { sql, external } = yield* database;
    external.exec("BEGIN IMMEDIATE");
    const started = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<void>();
    const writing = yield* Deferred.succeed(started, undefined).pipe(
      Effect.andThen(sql`UPDATE items SET value = 2`),
      Effect.ensuring(Deferred.succeed(finished, undefined)),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* NodeSqliteClient.eventLoopTurn;
    expect(yield* Deferred.isDone(finished)).toBe(false);
    external.exec("COMMIT");
    yield* Fiber.join(writing);
    expect((yield* sql<{ value: number }>`SELECT value FROM items`)[0]?.value).toBe(2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("worker transactions roll back on failure", () =>
  Effect.gen(function* () {
    const { sql } = yield* database;
    const result = yield* sql
      .withTransaction(sql`UPDATE items SET value = 3`.pipe(Effect.andThen(Effect.fail("abort"))))
      .pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    expect((yield* sql<{ value: number }>`SELECT value FROM items`)[0]?.value).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("writer lock retries are bounded and leave the next transaction usable", () =>
  Effect.gen(function* () {
    const { sql, external } = yield* database;
    external.exec("BEGIN IMMEDIATE");
    const blocked = yield* sql`UPDATE items SET value = 4`.pipe(Effect.exit);
    expect(Exit.isFailure(blocked)).toBe(true);
    external.exec("COMMIT");
    yield* sql.withTransaction(sql`UPDATE items SET value = 5`);
    expect((yield* sql<{ value: number }>`SELECT value FROM items`)[0]?.value).toBe(5);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("production persistence initializes WAL and migrations through the writer worker", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-sqlite-production-" });
    const context = yield* Layer.build(SqlitePersistence.layerFromPath(`${root}/state.sqlite`));
    const sql = Context.get(context, SqlClient.SqlClient);
    const mode = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`;
    expect(mode[0]?.journal_mode).toBe("wal");
    const tables = yield* sql<{
      name: string;
    }>`SELECT name FROM sqlite_schema WHERE name = 'orchestration_events'`.pipe(
      NodeSqliteClient.readOnly,
    );
    expect(tables[0]?.name).toBe("orchestration_events");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

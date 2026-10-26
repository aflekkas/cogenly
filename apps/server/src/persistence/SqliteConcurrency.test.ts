import * as SqlitePersistence from "./Sqlite.ts";
import * as NodeSqlite from "node:sqlite";
import { vi } from "vite-plus/test";
import * as TestClock from "effect/testing/TestClock";

const workerState = vi.hoisted(() => ({
  failWriter: false,
  writers: [] as import("node:worker_threads").Worker[],
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        const writable = args[1]?.workerData?.writable === true;
        if (writable && workerState.failWriter) throw new Error("Worker unavailable in fixture");
        super(...args);
        if (writable) workerState.writers.push(this);
      }
    },
  };
});
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
      connectionPragmas: ["PRAGMA foreign_keys = ON", "PRAGMA synchronous = NORMAL"],
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
    const started = performance.now();
    const blocked = yield* sql`UPDATE items SET value = 4`.pipe(Effect.exit);
    expect(Exit.isFailure(blocked)).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(4500);
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

it.effect("writer startup is lazy and unavailable workers fall back without preventing boot", () =>
  Effect.gen(function* () {
    const before = workerState.writers.length;
    workerState.failWriter = true;
    try {
      const { sql } = yield* database;
      expect(workerState.writers.length).toBe(before);
      yield* sql.withTransaction(sql`UPDATE items SET value = 6`);
      expect((yield* sql<{ value: number }>`SELECT value FROM items`)[0]?.value).toBe(6);
      expect(NodeSqliteClient.load(sql)?.writerWorkerUnavailable).toBe(true);
      expect((yield* sql<{ foreign_keys: number }>`PRAGMA foreign_keys`)[0]?.foreign_keys).toBe(1);
      workerState.failWriter = false;
      yield* TestClock.adjust(1000);
      yield* sql`UPDATE items SET value = 7`;
      expect(workerState.writers.length).toBe(before + 1);
      expect(NodeSqliteClient.load(sql)?.writerWorkerUnavailable).toBe(false);
      expect((yield* sql<{ foreign_keys: number }>`PRAGMA foreign_keys`)[0]?.foreign_keys).toBe(1);
    } finally {
      workerState.failWriter = false;
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a dead transaction fails and queued writes acquire a replacement worker", () =>
  Effect.gen(function* () {
    const { sql } = yield* database;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const first = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE items SET value = 10`;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          yield* sql`UPDATE items SET value = 11`;
        }),
      )
      .pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.await(entered);
    const worker = workerState.writers.at(-1)!;
    const queued = yield* sql
      .withTransaction(sql`UPDATE items SET value = value + 2`)
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => worker.terminate());
    expect(NodeSqliteClient.load(sql)?.writerWorkerUnavailable).toBe(true);
    yield* Deferred.succeed(release, undefined);
    expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true);
    yield* Fiber.join(queued);
    expect(workerState.writers.at(-1)).not.toBe(worker);
    expect(NodeSqliteClient.load(sql)?.writerWorkerUnavailable).toBe(false);
    expect((yield* sql<{ value: number }>`SELECT value FROM items`)[0]?.value).toBe(2);
    expect((yield* sql<{ foreign_keys: number }>`PRAGMA foreign_keys`)[0]?.foreign_keys).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("parallel statements in a transaction survive an in-worker lock retry", () =>
  Effect.gen(function* () {
    const { sql, external } = yield* database;
    yield* sql`SELECT 1`;
    const worker = workerState.writers.at(-1)!;
    const busy = Effect.callback<void>((resume) => {
      const listener = (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "busy"
        ) {
          resume(Effect.void);
        }
      };
      worker.on("message", listener);
      return Effect.sync(() => {
        worker.off("message", listener);
      });
    });
    const retry = yield* busy.pipe(Effect.forkChild);
    external.exec("BEGIN IMMEDIATE");
    const writing = yield* sql
      .withTransaction(
        Effect.all(
          Array.from({ length: 8 }, () => sql`UPDATE items SET value = value + 1`),
          { concurrency: "unbounded" },
        ),
      )
      .pipe(Effect.forkChild);
    yield* Fiber.join(retry);
    expect(NodeSqliteClient.load(sql)?.writerBusyRetries).toBeGreaterThan(0);
    external.exec("COMMIT");
    yield* Fiber.join(writing);
    expect((yield* sql<{ value: number }>`SELECT value FROM items`)[0]?.value).toBe(8);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("production migrations boot with a warning when writer workers cannot start", () =>
  Effect.gen(function* () {
    workerState.failWriter = true;
    try {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-sqlite-fallback-" });
      const context = yield* Layer.build(SqlitePersistence.layerFromPath(`${root}/state.sqlite`));
      const sql = Context.get(context, SqlClient.SqlClient);
      expect(NodeSqliteClient.load(sql)?.writerWorkerUnavailable).toBe(true);
      expect(
        (yield* sql`SELECT name FROM sqlite_schema WHERE name = 'orchestration_events'`).length,
      ).toBe(1);
      expect((yield* sql<{ foreign_keys: number }>`PRAGMA foreign_keys`)[0]?.foreign_keys).toBe(1);
    } finally {
      workerState.failWriter = false;
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

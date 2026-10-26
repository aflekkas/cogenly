import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@cogenly/shared/nodeSqliteClient";
import { backfillRate, make, runPass } from "./BackfillBudget.ts";

it.effect("ends a pass once its time budget is spent", () =>
  Effect.gen(function* () {
    let batches = 0;
    const more = yield* runPass(
      Effect.gen(function* () {
        batches++;
        yield* TestClock.adjust(30);
        return true;
      }),
    );
    expect(more).toBe(true);
    expect(batches).toBe(2);
  }),
);

it.live("gives native callbacks a turn between batches", () =>
  Effect.gen(function* () {
    let callbackRan = false;
    let batches = 0;
    yield* runPass(
      Effect.sync(() => {
        batches++;
        if (batches === 1) {
          setImmediate(() => {
            callbackRan = true;
          });
          return true;
        }
        expect(callbackRan).toBe(true);
        return false;
      }),
    );
    expect(batches).toBe(2);
  }),
);

it.effect("paces interactive catch-up and releases the limit when idle", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const budget = yield* make;
    yield* sql`SELECT 1`.pipe(NodeSqliteClient.interactive);
    yield* budget.completed(32, 5);
    const done = yield* Deferred.make<void>();
    const waiting = yield* budget.ready.pipe(
      Effect.andThen(Deferred.succeed(done, undefined)),
      Effect.forkChild,
    );
    yield* TestClock.adjust(639);
    expect(yield* Deferred.isDone(done)).toBe(false);
    yield* TestClock.adjust(1);
    yield* Fiber.join(waiting);
    // A large preceding batch would wait several seconds at the interactive rate.
    yield* budget.completed(256, 30);
    yield* TestClock.adjust(2000);
    const before = yield* Clock.currentTimeMillis;
    yield* budget.ready;
    expect(yield* Clock.currentTimeMillis).toBe(before);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it("backs off further under event-loop or writer pressure", () => {
  expect(backfillRate(true, 0, 0)).toBe(50);
  expect(backfillRate(false, 0, 0)).toBe(Infinity);
  expect(backfillRate(false, 21, 0)).toBe(10);
  expect(backfillRate(true, 0, 26)).toBe(10);
});

it.effect("adds unpaid charges from consecutive peers instead of replacing them", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const budget = yield* make;
    yield* sql`SELECT 1`.pipe(NodeSqliteClient.interactive);
    yield* budget.completed(10, 5);
    yield* TestClock.adjust(100);
    yield* budget.completed(10, 5);
    const done = yield* Deferred.make<void>();
    const waiting = yield* budget.ready.pipe(
      Effect.andThen(Deferred.succeed(done, undefined)),
      Effect.forkChild,
    );
    yield* TestClock.adjust(299);
    expect(yield* Deferred.isDone(done)).toBe(false);
    yield* TestClock.adjust(1);
    yield* Fiber.join(waiting);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

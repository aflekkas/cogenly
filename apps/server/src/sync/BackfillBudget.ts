import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@cogenly/shared/nodeSqliteClient";

export const PASS_BUDGET_MS = 50;

/** Returns true when another pass is needed. The pass budget is checked between peer calls;
 * a running batch is never interrupted. */
export const runPass = <E, R>(step: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    for (;;) {
      if (!(yield* step)) return false;
      yield* NodeSqliteClient.eventLoopTurn;
      if ((yield* Clock.currentTimeMillis) - started >= PASS_BUDGET_MS) return true;
    }
  });

export const backfillRate = (interactive: boolean, lagMs: number, writerWaitMs: number) => {
  if (lagMs > 20 || writerWaitMs > 25) return 10;
  return interactive ? 50 : Infinity;
};

/** One budget per direction, shared by peers so adding peers cannot multiply the rate. */
export const make = Effect.gen(function* () {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  let batchEvents = 32;
  let lagMs = 0;
  let charged = 0;
  let chargedAt = 0;
  const rate = (now: number) => {
    const pressure = Option.isSome(sql) ? NodeSqliteClient.load(sql.value) : undefined;
    return backfillRate(
      pressure !== undefined && now - pressure.interactiveAt < 2000,
      lagMs,
      pressure !== undefined && now - pressure.writerWaitAt < 5000 ? pressure.writerWaitMs : 0,
    );
  };
  const ready = Effect.gen(function* () {
    // Recheck activity while waiting: idle work immediately regains full speed.
    for (;;) {
      const now = yield* Clock.currentTimeMillis;
      const delay = (charged * 1000) / rate(now) - (now - chargedAt);
      if (delay <= 0) return;
      yield* Effect.sleep(Math.min(delay, 100));
    }
  });
  const completed = (events: number, elapsedMs: number) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      // Retain unpaid work from earlier peers without charging elapsed time twice.
      const currentRate = rate(now);
      charged =
        (currentRate === Infinity
          ? 0
          : Math.max(0, charged - ((now - chargedAt) * currentRate) / 1000)) + events;
      chargedAt = now;
      batchEvents =
        elapsedMs > 25
          ? Math.max(1, Math.floor(batchEvents / 2))
          : elapsedMs < 10
            ? Math.min(64, batchEvents + 8)
            : batchEvents;
      const before = yield* Clock.currentTimeMillis;
      yield* NodeSqliteClient.eventLoopTurn;
      lagMs = Math.max(0, (yield* Clock.currentTimeMillis) - before - 1);
    });
  return { ready, completed, batchEvents: () => batchEvents };
});

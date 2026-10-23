import { describe, expect, it } from "@effect/vitest";

import { planDatabaseMaintenance, planLogPruning } from "./ServerHousekeeping.ts";

describe("planLogPruning", () => {
  const now = 1_800_000_000_000;
  const day = 86_400_000;

  it("removes only files older than the retention window", () => {
    const plan = planLogPruning(
      [
        { path: "/logs/old.log.1", modifiedAtMs: now - 31 * day },
        { path: "/logs/fresh.log", modifiedAtMs: now - 1 * day },
      ],
      now,
      30,
    );
    expect(plan.remove).toEqual(["/logs/old.log.1"]);
    expect(plan.keep).toEqual(["/logs/fresh.log"]);
  });

  it("removes nothing when retention is unset", () => {
    const plan = planLogPruning([{ path: "/logs/old.log.1", modifiedAtMs: 0 }], now, null);
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual(["/logs/old.log.1"]);
  });
});

describe("planDatabaseMaintenance", () => {
  it("always optimizes, vacuums only with incremental vacuum and free pages", () => {
    expect(planDatabaseMaintenance({ incrementalVacuumEnabled: true, freelistCount: 10 })).toEqual({
      runOptimize: true,
      runIncrementalVacuum: true,
    });
    expect(planDatabaseMaintenance({ incrementalVacuumEnabled: true, freelistCount: 0 })).toEqual({
      runOptimize: true,
      runIncrementalVacuum: false,
    });
    expect(planDatabaseMaintenance({ incrementalVacuumEnabled: false, freelistCount: 10 })).toEqual(
      { runOptimize: true, runIncrementalVacuum: false },
    );
  });
});

import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type MachineHealthItem } from "@cogenly/contracts";
import * as Schema from "effect/Schema";
import {
  AutoFixAttempt,
  healthAutoFixView,
  initialHealthAutoFixState,
  isAutoFixable,
  planHealthAutoFix,
  recordHealthAutoFix,
} from "./healthAutoFix.ts";

const self = EnvironmentId.make("self");
const peer = EnvironmentId.make("peer");
const item: MachineHealthItem = {
  key: "sync:peer",
  status: "fail",
  title: "Sync stuck",
  detail: "No progress",
  since: null,
  target: { _tag: "machine", environmentId: peer },
  fix: "retry-sync",
};
const minute = 60_000;
const decodeAttempt = Schema.decodeSync(Schema.fromJsonString(AutoFixAttempt));

describe("automatic health retry policy", () => {
  it.each(["fixed", "failed"] as const)(
    "caps lifetime attempts even when the last outcome was %s",
    (status) => {
      let state = initialHealthAutoFixState;
      for (const now of [0, 10 * minute, 30 * minute]) {
        const plan = planHealthAutoFix(state, [item], self, now);
        expect(plan.due).toEqual([item]);
        state = recordHealthAutoFix(plan.state, item.key, { status, message: "Outcome" });
        expect(planHealthAutoFix(state, [item], self, now + 1).due).toEqual([]);
      }
      // Persist/reload, and disappearance/reappearance, cannot renew the budget.
      state = new Map(
        [...state].map(([key, value]) => [key, decodeAttempt(JSON.stringify(value))]),
      );
      state = planHealthAutoFix(state, [], self, 100 * minute).state;
      for (const now of [100, 1_000, 100_000]) {
        const plan = planHealthAutoFix(state, [item], self, now * minute);
        expect(plan.due).toEqual([]);
        expect(healthAutoFixView(plan.state).failures.has(item.key)).toBe(true);
        state = plan.state;
      }
      expect(
        planHealthAutoFix(state, [{ ...item, detail: "New backlog count" }], self, 100_001 * minute)
          .due,
      ).toEqual([]);
    },
  );

  it("keeps one budget while elapsed time, backlog, titles and status change", () => {
    let state = initialHealthAutoFixState;
    const attempts: number[] = [];
    for (let sample = 0; sample < 1_000; sample++) {
      const changing = {
        ...item,
        detail: `${sample} minutes; ${sample + 1} queued`,
        title: `Sync ${sample}`,
        status: sample % 2 ? ("warn" as const) : ("fail" as const),
      };
      const plan = planHealthAutoFix(state, [changing], self, sample * minute);
      state = plan.state;
      if (plan.due.length > 0) {
        attempts.push(sample);
        state = recordHealthAutoFix(state, item.key, { status: "fixed", message: "Sync ran" });
      }
    }
    expect(attempts).toEqual([0, 10, 30]);
    expect(state.get(item.key)?.attempts).toBe(3);
    expect(healthAutoFixView(state).holds.has(item.key)).toBe(false);
    expect(healthAutoFixView(state).failures.get(item.key)).toContain("still present");
  });

  it("renews an update budget only when its target version changes", () => {
    const update = { ...item, fix: "update-machine" as const };
    let state = initialHealthAutoFixState;
    for (const now of [0, 10, 30])
      state = planHealthAutoFix(state, [update], self, now * minute, "0.3.4").state;
    expect(
      planHealthAutoFix(
        state,
        [{ ...update, detail: "Renamed machine" }],
        self,
        100 * minute,
        "0.3.4",
      ).due,
    ).toEqual([]);
    expect(planHealthAutoFix(state, [update], self, 101 * minute, "0.3.5").due).toEqual([update]);
  });

  it("backs off exponentially across failures and successful but lingering fixes", () => {
    let plan = planHealthAutoFix(initialHealthAutoFixState, [item], self, 0);
    let state = recordHealthAutoFix(plan.state, item.key, { status: "failed", message: "Offline" });
    expect(planHealthAutoFix(state, [item], self, 9 * minute).due).toEqual([]);
    plan = planHealthAutoFix(state, [item], self, 10 * minute);
    expect(plan.due).toHaveLength(1);
    state = recordHealthAutoFix(plan.state, item.key, { status: "fixed", message: "Retried" });
    expect(planHealthAutoFix(state, [item], self, 29 * minute).due).toEqual([]);
    expect(planHealthAutoFix(state, [item], self, 30 * minute).due).toHaveLength(1);
  });

  it("quiet deferral waits without consuming the lifetime budget", () => {
    const plan = planHealthAutoFix(initialHealthAutoFixState, [item], self, 0);
    const state = recordHealthAutoFix(plan.state, item.key, {
      status: "deferred",
      message: "Busy",
    });
    expect(state.get(item.key)?.attempts).toBe(0);
    expect(healthAutoFixView(state).holds.has(item.key)).toBe(true);
    expect(planHealthAutoFix(state, [item], self, minute).due).toEqual([]);
    expect(planHealthAutoFix(state, [item], self, 10 * minute).due).toEqual([item]);
  });

  it("limits automation to safe fixes and updates initiated by the newer machine", () => {
    expect(isAutoFixable({ ...item, fix: "run-now" }, self)).toBe(false);
    expect(isAutoFixable({ ...item, status: "unknown" }, self)).toBe(false);
    expect(
      isAutoFixable(
        { ...item, fix: "update-machine", target: { _tag: "machine", environmentId: self } },
        self,
      ),
    ).toBe(false);
    expect(isAutoFixable({ ...item, fix: "update-machine" }, self)).toBe(true);
  });
});

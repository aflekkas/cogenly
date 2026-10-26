import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type MachineHealthItem,
  type MachineHealthStatus,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";

import {
  HEALTH_ALERT_RESOLVED_LIMIT,
  evaluateHealthAlerts,
  healthAlertsSnapshot,
  initialHealthAlertEngineState,
  type HealthAlertEngineState,
  type HealthObservation,
  type HealthRound,
} from "./healthAlertEngine.ts";

const hub = EnvironmentId.make("hub");
const minute = 60_000;
const at = (minutes: number) => DateTime.makeUnsafe(minutes * minute);

const item = (status: MachineHealthStatus, key = "providers:claude"): MachineHealthItem => ({
  key,
  status,
  title: status === "fail" ? "Claude is signed out" : "Claude needs sign-in",
  detail: "Sign in again.",
  since: null,
  target: null,
  fix: "sign-in",
});

const seen = (status: MachineHealthStatus, key?: string): HealthObservation => ({
  originEnvironmentId: hub,
  originMachineName: "Contabo VPS",
  checkId: "providers",
  item: item(status, key),
});

/** Runs one round per minute, returning every round's evaluation. */
function run(rounds: ReadonlyArray<HealthRound>, start = 0, from = initialHealthAlertEngineState) {
  let state: HealthAlertEngineState = from;
  return rounds.map((round, index) => {
    const result = evaluateHealthAlerts(state, round, at(start + index));
    state = result.state;
    return result;
  });
}
const bad = { observations: [seen("warn")] };
const ok = { observations: [seen("ok")] };
const absent = { observations: [] };

const transitions = (results: ReturnType<typeof run>) =>
  results.map((result) =>
    result.opened.length > 0
      ? "open"
      : result.resolved.length > 0
        ? "resolve"
        : result.changed
          ? "change"
          : "-",
  );

describe("health alert engine", () => {
  it("opens only after the item stays bad for the open debounce, then stays quiet", () => {
    const results = run([bad, bad, bad, bad, bad]);
    expect(transitions(results)).toEqual(["-", "-", "open", "-", "-"]);
    const opened = results[2]!.opened[0]!;
    expect(opened.id).toBe(`${hub}:providers:claude:${2 * minute}`);
    expect(opened).toMatchObject({
      state: "open",
      status: "warn",
      originMachineName: "Contabo VPS",
    });
    expect(healthAlertsSnapshot(results[4]!.state).open).toEqual([opened]);
  });

  it("resolves only after the item stays ok or absent for the resolve debounce", () => {
    const results = run([bad, bad, bad, ok, absent, ok, ok]);
    expect(transitions(results)).toEqual(["-", "-", "open", "-", "-", "resolve", "-"]);
    const resolved = results[5]!.resolved[0]!;
    expect(resolved).toMatchObject({ state: "resolved", id: results[2]!.opened[0]!.id });
    expect(resolved.resolvedAt).toEqual(at(5));
    expect(healthAlertsSnapshot(results[6]!.state)).toEqual({
      open: [],
      recentlyResolved: [resolved],
    });
  });

  it("says nothing for an item flapping inside either debounce", () => {
    expect(transitions(run([bad, ok, bad, ok, bad, absent, bad]))).toEqual([
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
    ]);
    const open = run([bad, bad, bad, ok, bad, ok, bad, ok, bad]);
    expect(transitions(open)).toEqual(["-", "-", "open", "-", "-", "-", "-", "-", "-"]);
    expect(healthAlertsSnapshot(open.at(-1)!.state).open).toHaveLength(1);
  });

  it("escalates warn to fail in place, keeping the id, without a new open", () => {
    const failing = { observations: [seen("fail")] };
    const results = run([bad, bad, bad, failing, failing, bad]);
    expect(transitions(results)).toEqual(["-", "-", "open", "change", "-", "-"]);
    const [alert] = healthAlertsSnapshot(results[5]!.state).open;
    expect(alert).toMatchObject({
      id: results[2]!.opened[0]!.id,
      status: "fail",
      title: "Claude is signed out",
    });
  });

  it("picks up a new title at the same severity in place, keeping the id", () => {
    const titled = (title: string): HealthRound => ({
      observations: [
        {
          ...seen("fail", "stuck-runs:thread:a"),
          item: { ...item("fail", "stuck-runs:thread:a"), title },
        },
      ],
    });
    const results = run([
      titled("3 subagents stuck"),
      titled("3 subagents stuck"),
      titled("3 subagents stuck"),
      titled("18 subagents stuck"),
      titled("18 subagents stuck"),
    ]);
    expect(transitions(results)).toEqual(["-", "-", "open", "change", "-"]);
    expect(healthAlertsSnapshot(results[4]!.state).open).toEqual([
      expect.objectContaining({ id: results[2]!.opened[0]!.id, title: "18 subagents stuck" }),
    ]);
  });

  it("treats unknown as holding the previous state", () => {
    const unknown = { observations: [seen("unknown")] };
    // Pending: unknown neither opens nor resets the streak.
    expect(transitions(run([bad, unknown, unknown, bad]))).toEqual(["-", "-", "-", "open"]);
    // Open: unknown neither resolves nor cancels a recovery in progress.
    expect(transitions(run([bad, bad, bad, unknown, unknown, unknown]))).toEqual([
      "-",
      "-",
      "open",
      "-",
      "-",
      "-",
    ]);
    expect(transitions(run([bad, bad, bad, ok, unknown, ok]))).toEqual([
      "-",
      "-",
      "open",
      "-",
      "-",
      "resolve",
    ]);
    // Never seen bad: unknown alone opens nothing.
    expect(transitions(run([unknown, unknown, unknown]))).toEqual(["-", "-", "-"]);
  });

  it("holds an item whose check could not run instead of resolving it", () => {
    const checkDown = {
      observations: [],
      unknownChecks: [{ originEnvironmentId: hub, checkId: "providers" as const }],
    };
    expect(transitions(run([bad, bad, bad, checkDown, checkDown, checkDown]))).toEqual([
      "-",
      "-",
      "open",
      "-",
      "-",
      "-",
    ]);
  });

  it("opens peer reachability on fail at once and ignores its early warn", () => {
    const key = "machine-links:reachable:hub";
    const reach = (status: MachineHealthStatus) => ({ observations: [seen(status, key)] });
    expect(transitions(run([reach("warn"), reach("warn"), reach("warn"), reach("fail")]))).toEqual([
      "-",
      "-",
      "-",
      "open",
    ]);
    // Still offline (warn after a short reconnect) keeps it open.
    expect(transitions(run([reach("fail"), reach("warn"), reach("warn"), reach("warn")]))).toEqual([
      "open",
      "-",
      "-",
      "-",
    ]);
  });

  it("keeps recentlyResolved bounded by count and age", () => {
    let state = initialHealthAlertEngineState;
    let minuteAt = 0;
    const step = (round: HealthRound) => {
      const result = evaluateHealthAlerts(state, round, at(minuteAt++));
      state = result.state;
      return result;
    };
    for (let index = 0; index < HEALTH_ALERT_RESOLVED_LIMIT + 5; index++) {
      const key = `disk:volume-${index}`;
      for (let round = 0; round < 3; round++) step({ observations: [seen("fail", key)] });
      for (let round = 0; round < 3; round++) step(absent);
    }
    expect(state.recentlyResolved).toHaveLength(HEALTH_ALERT_RESOLVED_LIMIT);
    expect(state.recentlyResolved[0]!.itemKey).toBe(
      `disk:volume-${HEALTH_ALERT_RESOLVED_LIMIT + 4}`,
    );
    minuteAt += 24 * 60;
    expect(step(absent).changed).toBe(true);
    expect(state.recentlyResolved).toEqual([]);
  });
});

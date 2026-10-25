import type {
  EnvironmentId,
  MachineHealthAlert,
  MachineHealthAlertsSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  healthAlertGroupKey,
  mergeHealthAlertSnapshots,
  parseSeenHealthAlertIds,
  planHealthAlertNotifications,
  rememberSeenHealthAlertIds,
  worstHealthStatus,
} from "./machineHealthAlerts.logic";

const env = (id: string) => id as EnvironmentId;
const HUB = env("hub");
const LAPTOP = env("laptop");

function alert(id: string, overrides: Partial<MachineHealthAlert> = {}): MachineHealthAlert {
  return {
    id,
    originEnvironmentId: HUB,
    originMachineName: "Contabo VPS",
    itemKey: `providers:${id}`,
    checkId: "providers",
    state: "open",
    status: "warn",
    title: `Alert ${id}`,
    detail: "",
    openedAt: DateTime.makeUnsafe(1_000),
    resolvedAt: null,
    target: null,
    fix: null,
    ...overrides,
  };
}

function snapshot(
  open: ReadonlyArray<MachineHealthAlert>,
  recentlyResolved: ReadonlyArray<MachineHealthAlert> = [],
): MachineHealthAlertsSnapshot {
  return { open, recentlyResolved };
}

describe("mergeHealthAlertSnapshots", () => {
  it("shows an alert reported by both the hub and the spoke once", () => {
    const shared = alert("a");
    const merged = mergeHealthAlertSnapshots([
      [HUB, snapshot([shared])],
      [LAPTOP, snapshot([shared, alert("b", { openedAt: DateTime.makeUnsafe(500) })])],
    ]);
    expect(merged.open.map(({ alert }) => alert.id)).toEqual(["b", "a"]);
    expect(merged.open.find(({ alert }) => alert.id === "a")?.via).toBe(HUB);
  });

  it("collapses alerts two servers raised for the same machine and item", () => {
    const fromHub = alert("hub-id", { itemKey: "machine-links:vps" });
    const fromSpoke = alert("spoke-id", {
      itemKey: "machine-links:vps",
      openedAt: DateTime.makeUnsafe(2_000),
    });
    const merged = mergeHealthAlertSnapshots([
      [LAPTOP, snapshot([fromSpoke])],
      [HUB, snapshot([fromHub])],
    ]);
    expect(merged.open).toHaveLength(1);
    expect(merged.open[0]).toMatchObject({ alert: { id: "hub-id" }, ids: ["hub-id", "spoke-id"] });
  });

  it("treats an alert as resolved once any server has seen it resolve", () => {
    const merged = mergeHealthAlertSnapshots([
      [HUB, snapshot([alert("a")])],
      [LAPTOP, snapshot([], [alert("a", { state: "resolved" })])],
    ]);
    expect(merged.open).toEqual([]);
    expect(merged.resolved.map(({ alert }) => alert.id)).toEqual(["a"]);
  });
});

describe("planHealthAlertNotifications", () => {
  it("toasts only alerts this device has not seen", () => {
    const merged = mergeHealthAlertSnapshots([[HUB, snapshot([alert("a"), alert("b")])]]);
    const plan = planHealthAlertNotifications(merged, new Set(["a"]), new Set());
    expect(plan.toast.map(({ alert }) => alert.id)).toEqual(["b"]);
    expect(plan.retract).toEqual([]);
  });

  it("toasts nothing again once every open alert is remembered as seen", () => {
    const merged = mergeHealthAlertSnapshots([[HUB, snapshot([alert("a")])]]);
    const first = planHealthAlertNotifications(merged, new Set(), new Set());
    expect(first.toast.map(({ alert }) => alert.id)).toEqual(["a"]);
    const seen = rememberSeenHealthAlertIds([], first.remember, new Set());
    // A reload or a reconnect delivers the same snapshot again.
    expect(planHealthAlertNotifications(merged, new Set(seen), new Set()).toast).toEqual([]);
  });

  it("stays quiet when the toasted id resolves but another server's id for it stays open", () => {
    const item = { itemKey: "machine-links:vps" };
    const both = mergeHealthAlertSnapshots([
      [HUB, snapshot([alert("hub-id", item)])],
      [LAPTOP, snapshot([alert("spoke-id", { ...item, openedAt: DateTime.makeUnsafe(2_000) })])],
    ]);
    const first = planHealthAlertNotifications(both, new Set(), new Set());
    expect(first.toast).toHaveLength(1);
    const seen = new Set(first.remember);
    const shown = new Set([healthAlertGroupKey(first.toast[0]!.alert)]);

    const hubRecovered = mergeHealthAlertSnapshots([
      [HUB, snapshot([], [alert("hub-id", { ...item, state: "resolved" })])],
      [LAPTOP, snapshot([alert("spoke-id", { ...item, openedAt: DateTime.makeUnsafe(2_000) })])],
    ]);
    const next = planHealthAlertNotifications(hubRecovered, seen, shown);
    expect(next.toast).toEqual([]);
    // Still open on the spoke, so its toast stays up.
    expect(next.retract).toEqual([]);
  });

  it("retracts only resolved alerts whose toast this session showed", () => {
    const merged = mergeHealthAlertSnapshots([
      [HUB, snapshot([], [alert("a", { state: "resolved" }), alert("b", { state: "resolved" })])],
    ]);
    const plan = planHealthAlertNotifications(
      merged,
      new Set(["a", "b"]),
      new Set([healthAlertGroupKey(alert("b"))]),
    );
    expect(plan.retract.map(({ alert }) => alert.id)).toEqual(["b"]);
    expect(plan.toast).toEqual([]);
  });
});

describe("rememberSeenHealthAlertIds", () => {
  it("keeps the newest ids within the limit", () => {
    expect(rememberSeenHealthAlertIds(["a", "b", "c"], ["d"], new Set(), 3)).toEqual([
      "b",
      "c",
      "d",
    ]);
  });

  it("moves a re-added id to the end instead of duplicating it", () => {
    expect(rememberSeenHealthAlertIds(["a", "b"], ["a"], new Set(), 3)).toEqual(["b", "a"]);
  });

  it("never drops an id whose alert is still open", () => {
    expect(rememberSeenHealthAlertIds(["open", "b", "c"], ["d"], new Set(["open"]), 3)).toEqual([
      "open",
      "c",
      "d",
    ]);
  });
});

describe("parseSeenHealthAlertIds", () => {
  it("ignores anything that is not a list of ids", () => {
    expect(parseSeenHealthAlertIds(null)).toEqual([]);
    expect(parseSeenHealthAlertIds("not json")).toEqual([]);
    expect(parseSeenHealthAlertIds('{"a":1}')).toEqual([]);
    expect(parseSeenHealthAlertIds('["a", 2, "", "b"]')).toEqual(["a", "b"]);
  });
});

describe("worstHealthStatus", () => {
  it("ranks fail over warn over unknown", () => {
    expect(worstHealthStatus([])).toBeNull();
    expect(worstHealthStatus(["unknown", "warn"])).toBe("warn");
    expect(worstHealthStatus(["warn", "fail", "unknown"])).toBe("fail");
  });
});

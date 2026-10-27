import type {
  EnvironmentId,
  MachineHealthAlert,
  MachineHealthAlertsSnapshot,
  ThreadId,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  healthAlertGroupKey,
  healthAlertGroupView,
  healthAlertProblems,
  mergeHealthAlertSnapshots,
  parseSeenHealthAlertIds,
  planHealthAlertNotifications,
  QUIET_HEALTH_PROBLEM_TTL_MS,
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
      [
        LAPTOP,
        snapshot([
          shared,
          alert("b", { checkId: "disk", itemKey: "disk:free", openedAt: DateTime.makeUnsafe(500) }),
        ]),
      ],
    ]);
    expect(merged.open.map(({ alert }) => alert.id)).toEqual(["b", "a"]);
    expect(merged.open.find(({ alert }) => alert.id === "a")?.via).toBe(HUB);
  });

  it("groups one machine's items of one check into one counted alert", () => {
    const title = "Athens Racing Master: Fixes, Kifissia & Riviera";
    // What a 0.3.0 server sends: one alert per stuck subagent.
    const stuck = Array.from({ length: 18 }, (_, index) =>
      alert(`stuck-${index}`, {
        checkId: "stuck-runs",
        itemKey: `stuck-runs:subagent:${index}`,
        status: "fail",
        title: `A subagent in "${title}" has been running for 2 days`,
        fix: "resume",
        target: { _tag: "thread", threadId: "e6c109f2" as ThreadId },
        openedAt: DateTime.makeUnsafe(1_000 + index),
      }),
    );
    const merged = mergeHealthAlertSnapshots([
      [LAPTOP, snapshot([...stuck, alert("other", { originEnvironmentId: LAPTOP })])],
    ]);
    expect(merged.open).toHaveLength(2);
    const group = merged.open.find(({ alert }) => alert.checkId === "stuck-runs")!;
    expect(group.items).toHaveLength(18);
    expect(group.ids).toHaveLength(18);
    expect(healthAlertGroupView(group)).toEqual({
      status: "fail",
      title: "18 stuck runs in one thread",
      description: `Contabo VPS: A subagent in "${title}" has been running for 2 days; A subagent in "${title}" has been running for 2 days; and 16 more.`,
    });
    expect(healthAlertProblems(group).map((problem) => problem.fix)).toEqual(
      Array.from({ length: 18 }, () => "resume"),
    );
  });

  it("reads a group of one as its own alert", () => {
    const merged = mergeHealthAlertSnapshots([
      [HUB, snapshot([alert("a", { detail: "Sign in again." })])],
    ]);
    expect(healthAlertGroupView(merged.open[0]!)).toEqual({
      status: "warn",
      title: "Alert a",
      description: "Contabo VPS: Sign in again.",
    });
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
    const merged = mergeHealthAlertSnapshots([
      [HUB, snapshot([alert("a"), alert("b", { checkId: "disk", itemKey: "disk:free" })])],
    ]);
    const plan = planHealthAlertNotifications(merged, new Set(["a"]), new Set());
    expect(plan.toast.map(({ alert }) => alert.id)).toEqual(["b"]);
    expect(plan.retract).toEqual([]);
  });

  it("updates a group's open toast in place when another of its items opens", () => {
    const first = mergeHealthAlertSnapshots([[HUB, snapshot([alert("a")])]]);
    const toasted = planHealthAlertNotifications(first, new Set(), new Set());
    expect(toasted.toast).toHaveLength(1);
    const seen = rememberSeenHealthAlertIds([], toasted.remember, new Set());
    const shown = new Set([healthAlertGroupKey(alert("a"))]);
    const grown = mergeHealthAlertSnapshots([
      [HUB, snapshot([alert("a"), alert("b", { openedAt: DateTime.makeUnsafe(2_000) })])],
    ]);
    const next = planHealthAlertNotifications(grown, new Set(seen), shown);
    expect(next.toast).toEqual([]);
    expect(next.remember).toEqual(["b"]);
  });

  it("toasts a closed group again for a new item, but not for the items it already showed", () => {
    const first = mergeHealthAlertSnapshots([[HUB, snapshot([alert("a")])]]);
    const toasted = planHealthAlertNotifications(first, new Set(), new Set());
    const seen = rememberSeenHealthAlertIds([], toasted.remember, new Set());
    // The toast was dismissed or closed by Fix, so the group is no longer shown.
    expect(planHealthAlertNotifications(first, new Set(seen), new Set()).toast).toEqual([]);
    // Another server raising its own id for the same item is not a new item.
    const echoed = mergeHealthAlertSnapshots([
      [HUB, snapshot([alert("a")])],
      [LAPTOP, snapshot([alert("a2", { itemKey: "providers:a" })])],
    ]);
    expect(planHealthAlertNotifications(echoed, new Set(seen), new Set()).toast).toEqual([]);
    const grown = mergeHealthAlertSnapshots([
      [HUB, snapshot([alert("a"), alert("b", { openedAt: DateTime.makeUnsafe(2_000) })])],
    ]);
    const next = planHealthAlertNotifications(grown, new Set(seen), new Set());
    expect(next.toast.map(({ items }) => items.map((item) => item.id))).toEqual([["a", "b"]]);
    expect(next.remember).toEqual(["b"]);
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

  it("toasts again when a dismissed warning escalates to a failure under the same id", () => {
    const warn = mergeHealthAlertSnapshots([[HUB, snapshot([alert("a", { fix: "resume" })])]]);
    const toasted = planHealthAlertNotifications(warn, new Set(), new Set());
    expect(toasted.toast).toHaveLength(1);
    // Ids from before seen keys existed are bare ids too, so they stay seen.
    const seen = rememberSeenHealthAlertIds([], toasted.remember, new Set());
    expect(seen).toEqual(["a"]);
    // The server escalates in place: same id, worse status.
    const failed = mergeHealthAlertSnapshots([
      [HUB, snapshot([alert("a", { fix: "resume", status: "fail" })])],
    ]);
    const escalated = planHealthAlertNotifications(failed, new Set(seen), new Set());
    expect(escalated.toast.map(({ alert }) => alert.status)).toEqual(["fail"]);
    const after = rememberSeenHealthAlertIds(seen, escalated.remember, new Set());
    expect(planHealthAlertNotifications(failed, new Set(after), new Set()).toast).toEqual([]);
  });

  it("retracts only resolved alerts whose toast this session showed", () => {
    const merged = mergeHealthAlertSnapshots([
      [
        HUB,
        snapshot(
          [],
          [
            alert("a", { state: "resolved", checkId: "disk", itemKey: "disk:free" }),
            alert("b", { state: "resolved" }),
          ],
        ),
      ],
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

describe("quiet problems that need the owner", () => {
  const DAY = QUIET_HEALTH_PROBLEM_TTL_MS;
  const signIn = (id: string, openedAtMs: number, overrides: Partial<MachineHealthAlert> = {}) =>
    alert(id, {
      itemKey: "providers:claude",
      fix: "sign-in",
      openedAt: DateTime.makeUnsafe(openedAtMs),
      ...overrides,
    });
  const resolvedAt = (atMs: number) => ({
    state: "resolved" as const,
    resolvedAt: DateTime.makeUnsafe(atMs),
  });
  const plan = (
    open: ReadonlyArray<MachineHealthAlert>,
    quiet: ReadonlyMap<string, number>,
    nowMs: number,
    resolved: ReadonlyArray<MachineHealthAlert> = [],
  ) =>
    planHealthAlertNotifications(
      mergeHealthAlertSnapshots([[HUB, snapshot(open, resolved)]]),
      new Set(),
      new Set(),
      quiet,
      nowMs,
    );

  it("pops up once, then stays quiet when a restart opens a new alert for it", () => {
    const first = plan([signIn("a", 0)], new Map(), 0);
    expect(first.toast).toHaveLength(1);
    expect(plan([signIn("b", 60_000)], first.quiet, 60_000).toast).toEqual([]);
  });

  it("pops up again when the server escalates it in place", () => {
    const first = plan([signIn("a", 0)], new Map(), 0);
    const escalated = planHealthAlertNotifications(
      mergeHealthAlertSnapshots([[HUB, snapshot([signIn("a", 0, { status: "fail" })])]]),
      new Set(first.remember),
      new Set(),
      first.quiet,
      60_000,
    );
    expect(escalated.toast.map(({ alert }) => [alert.id, alert.status])).toEqual([["a", "fail"]]);
  });

  it("stays quiet for a day after it clears, then may pop up again", () => {
    const opened = plan([signIn("a", 0)], new Map(), 0);
    const cleared = plan([], opened.quiet, 1_000, [signIn("a", 0, resolvedAt(1_000))]);
    expect(plan([signIn("b", 2_000)], cleared.quiet, 2_000).toast).toEqual([]);
    expect(plan([signIn("c", 1_000 + DAY)], cleared.quiet, 1_000 + DAY).toast).toHaveLength(1);
  });

  it("counts the day from when it resolved, even when this client saw that later", () => {
    const opened = plan([signIn("a", 0)], new Map(), 0);
    // Closed for a while: the resolution arrives with the next snapshot.
    const back = plan([], opened.quiet, 1_000, [signIn("a", 0, resolvedAt(DAY / 2))]);
    expect([...back.quiet.values()]).toEqual([DAY / 2]);
    expect(plan([signIn("b", DAY)], back.quiet, DAY).toast).toEqual([]);
    expect(plan([signIn("c", DAY * 1.5)], back.quiet, DAY * 1.5).toast).toHaveLength(1);
    // Seen only after its day was up: nothing is left to keep it quiet.
    const late = plan([], opened.quiet, 2 * DAY, [signIn("a", 0, resolvedAt(DAY / 2))]);
    expect(late.quiet.size).toBe(0);
  });

  it("expires a problem that vanished without a resolution a day after it was last seen", () => {
    const opened = plan([signIn("a", 0)], new Map(), 0);
    // Its machine disconnected: no snapshot, so no resolution either.
    const gone = plan([], opened.quiet, 1_000);
    expect(plan([signIn("b", 2_000)], gone.quiet, 2_000).toast).toEqual([]);
    expect(plan([], gone.quiet, DAY).quiet.size).toBe(0);
    expect(plan([signIn("c", DAY + 1)], gone.quiet, DAY + 1).toast).toHaveLength(1);
  });

  it("keeps toasting problems Fix can clear on its own", () => {
    const stuck = (id: string) =>
      alert(id, { checkId: "stuck-runs", itemKey: "stuck-runs:t", fix: "stop-runs" });
    const first = plan([stuck("a")], new Map(), 0);
    expect(plan([stuck("b")], first.quiet, 60_000).toast).toHaveLength(1);
  });
});

describe("sync titles", () => {
  const sync = (id: string, target: MachineHealthAlert["target"]) =>
    alert(id, { checkId: "sync", itemKey: `sync:${id}`, target });

  it("counts the machines sync problems name", () => {
    const items = [
      sync("a", { _tag: "machine", environmentId: HUB }),
      sync("b", { _tag: "machine", environmentId: LAPTOP }),
    ];
    expect(healthAlertGroupView({ alert: items[0]!, items }).title).toBe(
      "Sync problems with 2 machines",
    );
  });

  it("does not count the origin of a quarantined thread as another machine", () => {
    const items = [
      sync("a", { _tag: "machine", environmentId: LAPTOP }),
      sync("b", { _tag: "thread", threadId: "t1" as ThreadId }),
    ];
    expect(healthAlertGroupView({ alert: items[0]!, items }).title).toBe("2 sync problems");
  });
});

describe("machine-links titles", () => {
  const reachable = (id: string, origin: EnvironmentId, name: string) =>
    alert(id, {
      originEnvironmentId: origin,
      originMachineName: name,
      checkId: "machine-links",
      itemKey: `machine-links:reachable:${origin}`,
      target: { _tag: "machine", environmentId: origin },
    });

  it("counts one machine with two problems as one machine", () => {
    const view = healthAlertGroupView({
      alert: reachable("a", HUB, "Contabo VPS"),
      items: [
        reachable("a", HUB, "Contabo VPS"),
        alert("b", {
          checkId: "machine-links",
          itemKey: `machine-version:${HUB}`,
          target: { _tag: "machine", environmentId: HUB },
        }),
      ],
    });
    expect(view.title).toBe("2 problems with one machine");
    expect(view.description.startsWith("Contabo VPS: ")).toBe(true);
  });

  it("counts distinct machines that can't be reached", () => {
    const items = [reachable("a", HUB, "Hub"), reachable("b", LAPTOP, "Laptop")];
    expect(healthAlertGroupView({ alert: items[0]!, items }).title).toBe(
      "2 machines can't be reached",
    );
  });
});

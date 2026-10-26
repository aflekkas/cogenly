import type {
  EnvironmentId,
  MachineHealthAlert,
  MachineHealthAlertsSnapshot,
  MachineHealthCheckId,
  MachineHealthStatus,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";

import type { MachineHealthProblem } from "./machineHealthLinks.logic";

/**
 * Machine health alerts as one client sees them. Every connected server
 * streams its own open alerts plus the ones it merged from its paired
 * machines, so the same alert can arrive from the hub and from the spoke.
 * Ids are unique per transition, which makes them the dedupe key.
 */

export interface MergedHealthAlert {
  /** The group's oldest alert: its machine, check and when the problem began. */
  readonly alert: MachineHealthAlert;
  /** The first server, in subscription order, that reported it. */
  readonly via: EnvironmentId;
  /**
   * Every open id collapsed into this group: one per item, and two servers can
   * each raise their own alert for the same item (a hub and a spoke both find
   * a third machine unreachable).
   */
  readonly ids: ReadonlyArray<string>;
  /** One alert per distinct item, oldest first. A toast counts these. */
  readonly items: ReadonlyArray<MachineHealthAlert>;
}

/**
 * One problem kind: the machine it is on and the check that went bad. Eighteen
 * stuck runs on one machine are one toast, never eighteen.
 */
export function healthAlertGroupKey(
  alert: Pick<MachineHealthAlert, "originEnvironmentId" | "checkId">,
): string {
  return JSON.stringify([alert.originEnvironmentId, alert.checkId]);
}

/** A thread's runs are one item from 0.3.2; earlier servers sent one per run. */
function stuckRunsTitle(items: ReadonlyArray<MachineHealthAlert>): string {
  const threads = new Set(
    items.map((item) => (item.target?._tag === "thread" ? item.target.threadId : item.itemKey)),
  );
  return threads.size === items.length
    ? `Stuck runs in ${threads.size} threads`
    : threads.size === 1
      ? `${items.length} stuck runs in one thread`
      : `${items.length} stuck runs in ${threads.size} threads`;
}

const GROUP_TITLES: Partial<
  Record<MachineHealthCheckId, (count: number, items: ReadonlyArray<MachineHealthAlert>) => string>
> = {
  "stuck-runs": (_count, items) => stuckRunsTitle(items),
  "scheduled-tasks": (count) => `${count} scheduled tasks need attention`,
  integrations: (count) => `${count} integrations need attention`,
  providers: (count) => `${count} provider problems`,
  sync: (count) => `Sync problems with ${count} machines`,
  "machine-links": (count) => `${count} machines can't be reached`,
};

/** Titles listed in a group's description before the rest are counted. */
const DESCRIPTION_TITLES = 2;

/** What a group's toast says: one item reads as itself, several are counted. */
export function healthAlertGroupView(entry: Pick<MergedHealthAlert, "alert" | "items">): {
  readonly status: MachineHealthStatus;
  readonly title: string;
  readonly description: string;
} {
  const { alert, items } = entry;
  const machine = alert.originMachineName;
  const status = worstHealthStatus(items.map((item) => item.status)) ?? alert.status;
  const [only, ...rest] = items;
  if (only === undefined || rest.length === 0) {
    const single = only ?? alert;
    return {
      status,
      title: single.title,
      description: single.detail.trim() ? `${machine}: ${single.detail}` : machine,
    };
  }
  const listed = items.slice(0, DESCRIPTION_TITLES).map((item) => item.title);
  const more = items.length - listed.length;
  return {
    status,
    title: GROUP_TITLES[alert.checkId]?.(items.length, items) ?? `${items.length} health problems`,
    description: `${machine}: ${listed.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`,
  };
}

/** The group's items as Fix takes them. */
export function healthAlertProblems(
  entry: Pick<MergedHealthAlert, "items">,
): ReadonlyArray<MachineHealthProblem> {
  return entry.items.map((item) => ({
    itemKey: item.itemKey,
    checkId: item.checkId,
    title: item.title,
    detail: item.detail,
    fix: item.fix,
    target: item.target,
  }));
}

export interface MergedHealthAlerts {
  /** Open everywhere it was reported, oldest first. */
  readonly open: ReadonlyArray<MergedHealthAlert>;
  readonly resolved: ReadonlyArray<MergedHealthAlert>;
}

const openedAtMs = (alert: MachineHealthAlert) => DateTime.toEpochMillis(alert.openedAt);

/**
 * One list across servers, deduped by id. A server that already saw an
 * alert resolve wins over one that still lists it open: an id never
 * reopens, so the other is behind. Open alerts for the same origin and check
 * then collapse into one group under the earliest, one entry per item.
 */
export function mergeHealthAlertSnapshots(
  snapshots: Iterable<readonly [EnvironmentId, MachineHealthAlertsSnapshot]>,
): MergedHealthAlerts {
  const openById = new Map<string, { alert: MachineHealthAlert; via: EnvironmentId }>();
  const resolved = new Map<string, MergedHealthAlert>();
  for (const [via, snapshot] of snapshots) {
    for (const alert of snapshot.recentlyResolved) {
      if (!resolved.has(alert.id))
        resolved.set(alert.id, { alert, via, ids: [alert.id], items: [alert] });
    }
    for (const alert of snapshot.open) {
      if (!openById.has(alert.id)) openById.set(alert.id, { alert, via });
    }
  }
  for (const id of resolved.keys()) openById.delete(id);
  const groups = new Map<string, MergedHealthAlert>();
  const byAge = [...openById.values()].toSorted(
    (left, right) => openedAtMs(left.alert) - openedAtMs(right.alert),
  );
  for (const entry of byAge) {
    const key = healthAlertGroupKey(entry.alert);
    const group = groups.get(key);
    groups.set(
      key,
      group === undefined
        ? { ...entry, ids: [entry.alert.id], items: [entry.alert] }
        : {
            ...group,
            ids: [...group.ids, entry.alert.id],
            items: group.items.some((item) => item.itemKey === entry.alert.itemKey)
              ? group.items
              : [...group.items, entry.alert],
          },
    );
  }
  return { open: [...groups.values()], resolved: [...resolved.values()] };
}

/** Worst first: fail > warn > unknown > ok. */
const STATUS_RANK = { fail: 3, warn: 2, unknown: 1, ok: 0 } as const satisfies Record<
  MachineHealthStatus,
  number
>;

export function worstHealthStatus(
  statuses: Iterable<MachineHealthStatus>,
): MachineHealthStatus | null {
  let worst: MachineHealthStatus | null = null;
  for (const status of statuses) {
    if (worst === null || STATUS_RANK[status] > STATUS_RANK[worst]) worst = status;
  }
  return worst;
}

export interface HealthAlertNotificationPlan {
  /** Newly open problems to toast, once each. */
  readonly toast: ReadonlyArray<MergedHealthAlert>;
  /** Problems that cleared everywhere whose toast this session showed, to close and confirm. */
  readonly retract: ReadonlyArray<MergedHealthAlert>;
  /** Open ids to add to `seen`: the toasted ones and any sibling of a problem already seen. */
  readonly remember: ReadonlyArray<string>;
}

/**
 * What changes on screen for a merged snapshot. `seen` is every alert id
 * this device has ever toasted (persisted, so a reload or reconnect stays
 * quiet); a problem is seen when any of its collapsed ids is. `shown` holds
 * the group keys (`healthAlertGroupKey`) toasted in this session and not
 * yet retracted: a problem one server resolved stays up while another
 * still reports it open.
 */
export function planHealthAlertNotifications(
  merged: MergedHealthAlerts,
  seen: ReadonlySet<string>,
  shown: ReadonlySet<string>,
): HealthAlertNotificationPlan {
  const openKeys = new Set(merged.open.map(({ alert }) => healthAlertGroupKey(alert)));
  const retract = new Map<string, MergedHealthAlert>();
  for (const entry of merged.resolved) {
    const key = healthAlertGroupKey(entry.alert);
    if (shown.has(key) && !openKeys.has(key) && !retract.has(key)) retract.set(key, entry);
  }
  const toast = merged.open.filter(({ ids }) => !ids.some((id) => seen.has(id)));
  return {
    toast,
    retract: [...retract.values()],
    // Every id of a seen problem counts as seen, so the problem stays quiet
    // when the id that was toasted resolves and a sibling remains.
    remember: merged.open.flatMap(({ ids }) => ids).filter((id) => !seen.has(id)),
  };
}

export const SEEN_HEALTH_ALERT_LIMIT = 200;

/**
 * Adds ids to the seen list, newest last, and drops the oldest past `limit`.
 * Ids in `keep` (alerts still open) are never dropped, or they would toast
 * again on the next snapshot.
 */
export function rememberSeenHealthAlertIds(
  previous: ReadonlyArray<string>,
  added: ReadonlyArray<string>,
  keep: ReadonlySet<string>,
  limit: number = SEEN_HEALTH_ALERT_LIMIT,
): string[] {
  const addedSet = new Set(added);
  const next = [...previous.filter((id) => !addedSet.has(id)), ...addedSet];
  let excess = next.length - limit;
  if (excess <= 0) return next;
  return next.filter((id) => {
    if (excess <= 0 || keep.has(id)) return true;
    excess -= 1;
    return false;
  });
}

/** Reads the persisted list, tolerating anything a past version or a user left there. */
export function parseSeenHealthAlertIds(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
  } catch {
    return [];
  }
}

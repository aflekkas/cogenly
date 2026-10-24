import type {
  EnvironmentId,
  MachineHealthAlert,
  MachineHealthAlertsSnapshot,
  MachineHealthStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Machine health alerts as one client sees them. Every connected server
 * streams its own open alerts plus the ones it merged from its paired
 * machines, so the same alert can arrive from the hub and from the spoke.
 * Ids are unique per transition, which makes them the dedupe key.
 */

export interface MergedHealthAlert {
  readonly alert: MachineHealthAlert;
  /** The first server, in subscription order, that reported it. */
  readonly via: EnvironmentId;
  /**
   * Every open id collapsed into this one: two servers can each raise their
   * own alert for the same problem (a hub and a spoke both find a third
   * machine unreachable), with different ids but the same origin and item.
   */
  readonly ids: ReadonlyArray<string>;
}

/** One problem: the machine it is on and the health item that went bad. */
export function healthAlertGroupKey(
  alert: Pick<MachineHealthAlert, "originEnvironmentId" | "itemKey">,
): string {
  return JSON.stringify([alert.originEnvironmentId, alert.itemKey]);
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
 * reopens, so the other is behind. Open alerts for the same origin and item
 * then collapse into the earliest one.
 */
export function mergeHealthAlertSnapshots(
  snapshots: Iterable<readonly [EnvironmentId, MachineHealthAlertsSnapshot]>,
): MergedHealthAlerts {
  const openById = new Map<string, { alert: MachineHealthAlert; via: EnvironmentId }>();
  const resolved = new Map<string, MergedHealthAlert>();
  for (const [via, snapshot] of snapshots) {
    for (const alert of snapshot.recentlyResolved) {
      if (!resolved.has(alert.id)) resolved.set(alert.id, { alert, via, ids: [alert.id] });
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
        ? { ...entry, ids: [entry.alert.id] }
        : { ...group, ids: [...group.ids, entry.alert.id] },
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

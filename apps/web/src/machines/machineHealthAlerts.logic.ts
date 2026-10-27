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
  /** `ids` by item key: an item is new while none of its ids is seen. */
  readonly idsByItem: ReadonlyMap<string, ReadonlyArray<string>>;
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

/** The machine an item is about: the one it names, else the one it is on. */
const machineOf = (item: MachineHealthAlert) =>
  item.target?._tag === "machine" ? item.target.environmentId : item.originEnvironmentId;

const distinctMachines = (items: ReadonlyArray<MachineHealthAlert>) =>
  new Set(items.map(machineOf)).size;

/** Two problems with one machine are one machine, never "2 machines". */
function machineLinksTitle(count: number, items: ReadonlyArray<MachineHealthAlert>): string {
  const machines = distinctMachines(items);
  if (items.every((item) => item.itemKey.startsWith("machine-links:reachable:")) && machines > 1)
    return `${machines} machines can't be reached`;
  return machines === 1
    ? `${count} problems with one machine`
    : `${count} problems across ${machines} machines`;
}

const GROUP_TITLES: Partial<
  Record<MachineHealthCheckId, (count: number, items: ReadonlyArray<MachineHealthAlert>) => string>
> = {
  "stuck-runs": (_count, items) => stuckRunsTitle(items),
  "scheduled-tasks": (count) => `${count} scheduled tasks need attention`,
  integrations: (count) => `${count} integrations need attention`,
  providers: (count) => `${count} provider problems`,
  sync: (count, items) => {
    const machines = distinctMachines(items);
    return machines === 1 ? `${count} sync problems` : `Sync problems with ${machines} machines`;
  },
  "machine-links": machineLinksTitle,
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
        resolved.set(alert.id, {
          alert,
          via,
          ids: [alert.id],
          items: [alert],
          idsByItem: new Map([[alert.itemKey, [alert.id]]]),
        });
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
    const { id, itemKey } = entry.alert;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        ...entry,
        ids: [id],
        items: [entry.alert],
        idsByItem: new Map([[itemKey, [id]]]),
      });
      continue;
    }
    const itemIds = group.idsByItem.get(itemKey);
    groups.set(key, {
      ...group,
      ids: [...group.ids, id],
      items: itemIds === undefined ? [...group.items, entry.alert] : group.items,
      idsByItem: new Map(group.idsByItem).set(itemKey, [...(itemIds ?? []), id]),
    });
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
  /** The quiet problems to persist: open ones that need the owner, and recently cleared ones. */
  readonly quiet: QuietHealthProblems;
}

/**
 * Problems that wait for the owner, by `quietProblemKey`: null while open,
 * else when it was seen to clear. Once one has popped up, it stays in the
 * machine's health without popping up again: not when a server restarts and
 * opens a new alert for it, nor when it clears and comes back within a day. A
 * new status (warn to fail) is a new key, so it pops up.
 */
export type QuietHealthProblems = ReadonlyMap<string, number | null>;

/** A cleared problem stays quiet this long if it comes back. */
export const QUIET_HEALTH_PROBLEM_TTL_MS = 24 * 60 * 60_000;

/** A sign-in, or a problem with no direct fix: only the owner or an agent clears it. */
export function needsOwner(alert: Pick<MachineHealthAlert, "fix">): boolean {
  return alert.fix === null || alert.fix === "sign-in";
}

/** Stable across alert ids: the machine, the item and its status. */
export function quietProblemKey(
  alert: Pick<MachineHealthAlert, "originEnvironmentId" | "itemKey" | "status">,
): string {
  return JSON.stringify([alert.originEnvironmentId, alert.itemKey, alert.status]);
}

/**
 * What changes on screen for a merged snapshot. `seen` is every alert id
 * this device has ever toasted (persisted, so a reload or reconnect stays
 * quiet); an item is seen when any of its collapsed ids is. `shown` holds
 * the group keys (`healthAlertGroupKey`) whose toast is on screen: it
 * updates in place as items come and go, and a problem one server resolved
 * stays up while another still reports it open. A group whose toast was
 * closed toasts again only for an item that is new since.
 */
export function planHealthAlertNotifications(
  merged: MergedHealthAlerts,
  seen: ReadonlySet<string>,
  shown: ReadonlySet<string>,
  quiet: QuietHealthProblems = new Map(),
  nowMs = 0,
): HealthAlertNotificationPlan {
  const openKeys = new Set(merged.open.map(({ alert }) => healthAlertGroupKey(alert)));
  const retract = new Map<string, MergedHealthAlert>();
  for (const entry of merged.resolved) {
    const key = healthAlertGroupKey(entry.alert);
    if (shown.has(key) && !openKeys.has(key) && !retract.has(key)) retract.set(key, entry);
  }
  const quietNow = (clearedAtMs: number | null | undefined) =>
    clearedAtMs === null ||
    (clearedAtMs !== undefined && nowMs - clearedAtMs < QUIET_HEALTH_PROBLEM_TTL_MS);
  const isQuiet = (item: MachineHealthAlert) =>
    needsOwner(item) && quietNow(quiet.get(quietProblemKey(item)));
  const toast = merged.open.filter(
    ({ alert, items, idsByItem }) =>
      !shown.has(healthAlertGroupKey(alert)) &&
      items.some(
        (item) => !(idsByItem.get(item.itemKey) ?? []).some((id) => seen.has(id)) && !isQuiet(item),
      ),
  );
  const nextQuiet = new Map<string, number | null>();
  for (const [key, clearedAtMs] of quiet)
    if (quietNow(clearedAtMs)) nextQuiet.set(key, clearedAtMs ?? nowMs);
  for (const { items } of merged.open)
    for (const item of items) if (needsOwner(item)) nextQuiet.set(quietProblemKey(item), null);
  return {
    toast,
    retract: [...retract.values()],
    // Every id of a seen problem counts as seen, so the problem stays quiet
    // when the id that was toasted resolves and a sibling remains.
    remember: merged.open.flatMap(({ ids }) => ids).filter((id) => !seen.has(id)),
    quiet: nextQuiet,
  };
}

/** Reads the persisted quiet problems, tolerating anything a past version or a user left there. */
export function parseQuietHealthProblems(raw: string | null): Map<string, number | null> {
  if (raw === null) return new Map();
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return new Map();
    return new Map(
      Object.entries(value).filter(
        (entry): entry is [string, number | null] =>
          entry[1] === null || (typeof entry[1] === "number" && Number.isFinite(entry[1])),
      ),
    );
  } catch {
    return new Map();
  }
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

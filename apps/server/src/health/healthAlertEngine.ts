/**
 * Turns rounds of health items into alert transitions, without I/O. An item
 * opens an alert once it has stayed bad for the open debounce and resolves it
 * once it has stayed ok (or gone) for the resolve debounce, so a flapping check
 * says nothing and an open problem is never repeated. HealthAlerts feeds it one
 * round per evaluation and delivers what it returns.
 */
import type {
  EnvironmentId,
  MachineHealthAlert,
  MachineHealthAlertsSnapshot,
  MachineHealthCheckId,
  MachineHealthItem,
  MachineHealthStatus,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";

/** Continuously bad this long before an alert opens. */
const HEALTH_ALERT_OPEN_AFTER = Duration.minutes(2);
/** Continuously ok or absent this long before an open alert resolves. */
const HEALTH_ALERT_RESOLVE_AFTER = Duration.minutes(2);
/** recentlyResolved keeps at most this many, and none older than a day. */
export const HEALTH_ALERT_RESOLVED_LIMIT = 20;
const RESOLVED_TTL = Duration.hours(24);

/** One item seen this round, on the machine the problem is on. */
export interface HealthObservation {
  readonly originEnvironmentId: EnvironmentId;
  readonly originMachineName: string;
  readonly checkId: MachineHealthCheckId;
  readonly item: MachineHealthItem;
}

export interface HealthRound {
  readonly observations: ReadonlyArray<HealthObservation>;
  /** Checks that could not run this round; their missing items hold instead of resolving. */
  readonly unknownChecks?: ReadonlyArray<{
    readonly originEnvironmentId: EnvironmentId;
    readonly checkId: MachineHealthCheckId;
  }>;
}

interface Tracked {
  readonly originEnvironmentId: EnvironmentId;
  readonly itemKey: string;
  readonly checkId: MachineHealthCheckId;
  /** Start of the current bad streak while no alert is open. */
  readonly badSince: DateTime.Utc | null;
  /** Start of the current ok streak while an alert is open. */
  readonly okSince: DateTime.Utc | null;
  readonly alert: MachineHealthAlert | null;
}

export interface HealthAlertEngineState {
  readonly tracked: ReadonlyMap<string, Tracked>;
  /** Newest first. */
  readonly recentlyResolved: ReadonlyArray<MachineHealthAlert>;
}

export const initialHealthAlertEngineState: HealthAlertEngineState = {
  tracked: new Map(),
  recentlyResolved: [],
};

interface HealthAlertEvaluation {
  readonly state: HealthAlertEngineState;
  readonly opened: ReadonlyArray<MachineHealthAlert>;
  readonly resolved: ReadonlyArray<MachineHealthAlert>;
  /** The snapshot differs: an open, a resolve, an escalation, or an expired resolved alert. */
  readonly changed: boolean;
}

/**
 * Peer reachability items (see peerReachability.ts) already wait ten minutes
 * before they fail, so they open on fail without a second debounce, and their
 * early "warn" never opens one.
 */
export const isReachabilityKey = (key: string) => key.startsWith("machine-links:reachable:");

const severity: Record<MachineHealthStatus, number> = { ok: 0, unknown: 0, warn: 1, fail: 2 };

const trackKey = (origin: EnvironmentId, key: string) => `${origin}\n${key}`;

type Reading = "bad" | "ok" | "hold";

function readingOf(
  observation: HealthObservation | undefined,
  previous: Tracked | undefined,
  heldChecks: ReadonlySet<string>,
): Reading {
  if (observation === undefined) {
    return previous !== undefined &&
      heldChecks.has(trackKey(previous.originEnvironmentId, previous.checkId))
      ? "hold"
      : "ok";
  }
  switch (observation.item.status) {
    case "unknown":
      return "hold";
    case "ok":
      return "ok";
    case "fail":
      return "bad";
    case "warn":
      // Still unreachable keeps an open reachability alert open, but a short
      // outage alone never opens one.
      return isReachabilityKey(observation.item.key) && (previous?.alert ?? null) === null
        ? "ok"
        : "bad";
  }
}

function openAlert(observation: HealthObservation, now: DateTime.Utc): MachineHealthAlert {
  const { item } = observation;
  return {
    id: `${observation.originEnvironmentId}:${item.key}:${DateTime.toEpochMillis(now)}`,
    originEnvironmentId: observation.originEnvironmentId,
    originMachineName: observation.originMachineName,
    itemKey: item.key,
    checkId: observation.checkId,
    state: "open",
    status: item.status,
    title: item.title,
    detail: item.detail,
    openedAt: now,
    resolvedAt: null,
    target: item.target,
    fix: item.fix,
  };
}

/** One round: every tracked or observed item steps once. */
export function evaluateHealthAlerts(
  state: HealthAlertEngineState,
  round: HealthRound,
  now: DateTime.Utc,
): HealthAlertEvaluation {
  const nowMs = DateTime.toEpochMillis(now);
  const seen = new Map<string, HealthObservation>();
  for (const observation of round.observations) {
    seen.set(trackKey(observation.originEnvironmentId, observation.item.key), observation);
  }
  const heldChecks = new Set(
    (round.unknownChecks ?? []).map((check) => trackKey(check.originEnvironmentId, check.checkId)),
  );
  const tracked = new Map<string, Tracked>();
  const opened: Array<MachineHealthAlert> = [];
  const resolved: Array<MachineHealthAlert> = [];
  let changed = false;

  for (const key of new Set([...state.tracked.keys(), ...seen.keys()])) {
    const previous = state.tracked.get(key);
    const observation = seen.get(key);
    const alert = previous?.alert ?? null;
    const reading = readingOf(observation, previous, heldChecks);
    if (reading === "hold") {
      if (previous !== undefined) tracked.set(key, previous);
      continue;
    }
    if (reading === "ok") {
      if (previous === undefined || alert === null) continue;
      const okSince = previous.okSince ?? now;
      if (
        nowMs - DateTime.toEpochMillis(okSince) >=
        Duration.toMillis(HEALTH_ALERT_RESOLVE_AFTER)
      ) {
        resolved.push({ ...alert, state: "resolved", resolvedAt: now });
        changed = true;
      } else {
        tracked.set(key, { ...previous, okSince });
      }
      continue;
    }
    // Bad: `observation` is present, since a missing item never reads bad.
    if (observation === undefined) continue;
    const { item } = observation;
    if (previous !== undefined && alert !== null) {
      // Worse in place keeps the alert's id; better or equal changes nothing.
      const escalated = severity[item.status] > severity[alert.status];
      tracked.set(key, {
        ...previous,
        okSince: null,
        alert: escalated
          ? {
              ...alert,
              status: item.status,
              title: item.title,
              detail: item.detail,
              target: item.target,
              fix: item.fix,
            }
          : alert,
      });
      if (escalated) changed = true;
      continue;
    }
    const badSince = previous?.badSince ?? now;
    const openAfter = isReachabilityKey(item.key) ? 0 : Duration.toMillis(HEALTH_ALERT_OPEN_AFTER);
    const base = {
      originEnvironmentId: observation.originEnvironmentId,
      itemKey: item.key,
      checkId: observation.checkId,
      okSince: null,
    };
    if (nowMs - DateTime.toEpochMillis(badSince) >= openAfter) {
      const created = openAlert(observation, now);
      opened.push(created);
      changed = true;
      tracked.set(key, { ...base, badSince: null, alert: created });
    } else {
      tracked.set(key, { ...base, badSince, alert: null });
    }
  }

  const oldest = nowMs - Duration.toMillis(RESOLVED_TTL);
  const candidates = [...resolved, ...state.recentlyResolved];
  const recentlyResolved = candidates
    .filter(
      (entry) => entry.resolvedAt === null || DateTime.toEpochMillis(entry.resolvedAt) >= oldest,
    )
    .slice(0, HEALTH_ALERT_RESOLVED_LIMIT);
  if (recentlyResolved.length !== candidates.length) changed = true;

  return { state: { tracked, recentlyResolved }, opened, resolved, changed };
}

/** Open alerts newest first, then the recently resolved ones. */
export function healthAlertsSnapshot(state: HealthAlertEngineState): MachineHealthAlertsSnapshot {
  const open: Array<MachineHealthAlert> = [];
  for (const entry of state.tracked.values()) if (entry.alert !== null) open.push(entry.alert);
  open.sort(
    (left, right) => DateTime.toEpochMillis(right.openedAt) - DateTime.toEpochMillis(left.openedAt),
  );
  return { open, recentlyResolved: state.recentlyResolved };
}

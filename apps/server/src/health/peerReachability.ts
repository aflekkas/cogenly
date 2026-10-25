/**
 * Whether a paired machine is reachable, as one health item. Shared by the
 * `machine-links` check, the synthesized report for an unreachable machine,
 * and health alerts ("Contabo VPS hasn't been reachable for 10 minutes").
 */
import type {
  EnvironmentId,
  MachineHealthItem,
  MachineHealthReport,
  MachineInfo,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";

/** Offline this long or longer is a failure; shorter is a warning (a restart, a hiccup). */
export const PEER_OFFLINE_FAIL_AFTER = Duration.minutes(10);

export const peerReachabilityKey = (environmentId: EnvironmentId) =>
  `machine-links:reachable:${environmentId}`;

/** "45 seconds", "3 minutes", "2 hours", "4 days": coarse, for titles. */
export function formatAgo(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const plural = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"}`;
  if (seconds < 60) return plural(seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return plural(hours, "hour");
  return plural(Math.floor(hours / 24), "day");
}

/**
 * Quiet this briefly after pairing or after last being seen reads as still
 * connecting, not as a problem. Matches the alerts' open debounce.
 */
export const PEER_CONNECT_GRACE = Duration.minutes(2);

/**
 * The reachability item for one paired machine, or null when it is online and
 * paired. Within the connect grace of pairing or of last being seen it is
 * `unknown` ("Connecting to …"); after that, offline under ten minutes warns,
 * ten minutes or more fails, and a revoked pairing fails. A machine never seen
 * since pairing fails once the grace is over: pairing brings it online, so not
 * seeing it at all means it never connected.
 */
export function peerReachabilityItem(input: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly online: boolean;
  readonly lastSeenAt: DateTime.Utc | null;
  readonly pairedAt: DateTime.Utc | null;
  readonly pairing: MachineInfo["pairing"];
  readonly now: DateTime.Utc;
}): MachineHealthItem | null {
  const key = peerReachabilityKey(input.environmentId);
  const target = { _tag: "machine", environmentId: input.environmentId } as const;
  if (input.pairing === "revoked") {
    return {
      key,
      status: "fail",
      title: `${input.name} is no longer paired`,
      detail: "The other machine revoked this pairing. Unpair it here and pair again.",
      since: null,
      target,
      fix: null,
    };
  }
  if (input.online) return null;
  const nowMs = DateTime.toEpochMillis(input.now);
  const quietSince = input.lastSeenAt ?? input.pairedAt;
  if (
    quietSince !== null &&
    nowMs - DateTime.toEpochMillis(quietSince) < Duration.toMillis(PEER_CONNECT_GRACE)
  ) {
    return {
      key,
      status: "unknown",
      title: `Connecting to ${input.name}…`,
      detail: "It hasn't checked in yet. This usually takes a few seconds.",
      since: null,
      target,
      fix: null,
    };
  }
  if (input.lastSeenAt === null) {
    return {
      key,
      status: "fail",
      title: `${input.name} hasn't been reachable since pairing`,
      detail: "It has not connected since it was paired.",
      since: null,
      target,
      fix: null,
    };
  }
  const offlineMs = nowMs - DateTime.toEpochMillis(input.lastSeenAt);
  const failed = offlineMs >= Duration.toMillis(PEER_OFFLINE_FAIL_AFTER);
  return {
    key,
    status: failed ? "fail" : "warn",
    title: `${input.name} hasn't been reachable for ${formatAgo(offlineMs)}`,
    // Clients show `since` in their own time format; this stays free of timestamps.
    detail: "It may be asleep, offline or restarting.",
    // When it went quiet, kept across the warn-to-fail step so it reads as one outage.
    since: input.lastSeenAt,
    target,
    fix: null,
  };
}

/**
 * A paired machine's report when it could not be read from the machine
 * itself: one `machine-links` check holding what this side knows.
 */
export function unreachableReport(input: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly item: MachineHealthItem;
  readonly now: DateTime.Utc;
}): MachineHealthReport {
  return {
    environmentId: input.environmentId,
    machineName: input.name,
    status: input.item.status,
    observedAt: input.now,
    serverVersion: "unknown",
    uptimeSeconds: 0,
    reachable: false,
    checks: [
      {
        id: "machine-links",
        status: input.item.status,
        summary: input.item.title,
        items: [input.item],
      },
    ],
  };
}

import {
  integrationCatalogEntryFor,
  type EnvironmentId,
  type IntegrationCatalogId,
  type IntegrationSummary,
  type MachineHealthChannelTestResult,
  type MachineHealthCheck,
  type MachineHealthCheckId,
  type MachineHealthReport,
  type MachineHealthStatus,
  type MachineInfo,
  type MachineListResult,
} from "@cogenly/contracts";

import { integrationAccountLabel } from "./integrationServices.logic";

export const HEALTH_STATUS_LABELS = {
  ok: "Healthy",
  warn: "Needs attention",
  fail: "Failing",
  unknown: "Unknown",
} as const satisfies Record<MachineHealthStatus, string>;

export const HEALTH_STATUS_BADGE_VARIANTS = {
  ok: "success",
  warn: "warning",
  fail: "error",
  unknown: "outline",
} as const satisfies Record<MachineHealthStatus, string>;

export const HEALTH_CHECK_LABELS = {
  server: "Server",
  database: "Database",
  disk: "Disk space",
  providers: "Providers",
  "machine-links": "Machine links",
  sync: "Sync",
  integrations: "Integrations",
  "scheduled-tasks": "Scheduled tasks",
  "stuck-runs": "Stuck runs",
  "boot-service": "Starts at boot",
  "tailscale-serve": "Private access",
  canary: "Canary check",
  "computer-use": "Computer use",
  "chat-terminal-sandbox": "Chat command sandbox",
  "agent-processes": "Agent processes",
  "preview-browser": "Preview browser",
} as const satisfies Record<MachineHealthCheckId, string>;

/**
 * The machine that runs the canary: the hub, which runs agents and schedules
 * around the clock. A machine that is not paired runs its own.
 */
export function canaryMachineId(list: MachineListResult): EnvironmentId | null {
  if (list.link._tag === "spoke") return list.link.hubEnvironmentId;
  return list.machines.find((machine) => machine.relation === "this")?.environmentId ?? null;
}

/** Checks that need the owner first, then the rest in the server's order. */
export function partitionHealthChecks(checks: ReadonlyArray<MachineHealthCheck>): {
  readonly problems: ReadonlyArray<MachineHealthCheck>;
  readonly others: ReadonlyArray<MachineHealthCheck>;
} {
  return {
    problems: checks.filter((check) => check.status === "warn" || check.status === "fail"),
    others: checks.filter((check) => check.status === "ok" || check.status === "unknown"),
  };
}

/** One line for the report as a whole. */
export function healthHeadline(report: MachineHealthReport): string {
  const failing = report.checks.filter((check) => check.status === "fail").length;
  const warning = report.checks.filter((check) => check.status === "warn").length;
  if (failing > 0) {
    return failing === 1 ? "1 check is failing" : `${failing} checks are failing`;
  }
  if (warning > 0) {
    return warning === 1 ? "1 check needs attention" : `${warning} checks need attention`;
  }
  if (report.checks.length > 0 && report.checks.every((check) => check.status === "unknown")) {
    return "Health couldn't be checked";
  }
  return "Everything is working";
}

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;

/** "10 minutes", "3 hours", "2 days": how long something has lasted. */
export function formatHealthDuration(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  return plural(Math.floor(hours / 24), "day");
}

/** E.g. "Contabo VPS hasn't been reachable for 10 minutes". */
export function unreachableHeadline(
  machineName: string,
  sinceMs: number | null,
  nowMs: number,
): string {
  if (sinceMs === null || nowMs - sinceMs < 60_000) {
    return `${machineName} can't be reached right now`;
  }
  return `${machineName} hasn't been reachable for ${formatHealthDuration(nowMs - sinceMs)}`;
}

/** The server's peer connect grace: this long after pairing or last being seen still reads as connecting. */
export const MACHINE_CONNECT_GRACE_MS = 2 * 60_000;

/**
 * What a machine's health section shows. Within the connect grace (just
 * paired, or an offline machine just seen) a missing, failed or unreachable
 * report reads "Connecting…", including one the server built before the
 * machine came online. Past the grace, a machine the list shows online never
 * reads as failing or unreachable: its report just didn't arrive.
 */
export type MachineHealthView =
  | { readonly _tag: "checking" }
  | { readonly _tag: "connecting" }
  | { readonly _tag: "error" }
  | {
      readonly _tag: "report";
      readonly overall: MachineHealthStatus;
      /** How an unreachable report reads: offline, or online with no report yet. */
      readonly unreachable: "offline" | "unanswered" | null;
    };

export function machineHealthView(input: {
  readonly report: MachineHealthReport | null;
  readonly failed: boolean;
  readonly machine: {
    readonly relation: MachineInfo["relation"];
    readonly online: boolean;
    readonly pairedAtMs: number | null;
    readonly lastSeenAtMs: number | null;
  };
  readonly nowMs: number;
}): MachineHealthView {
  const { report, machine } = input;
  const quietSince = machine.online
    ? machine.pairedAtMs
    : (machine.lastSeenAtMs ?? machine.pairedAtMs);
  const inGrace =
    machine.relation !== "this" &&
    quietSince !== null &&
    input.nowMs - quietSince < MACHINE_CONNECT_GRACE_MS;
  if (report === null) {
    if (inGrace) return { _tag: "connecting" };
    return input.failed ? { _tag: "error" } : { _tag: "checking" };
  }
  if (report.reachable) return { _tag: "report", overall: report.status, unreachable: null };
  // The server marks an offline machine inside its grace `unknown`.
  if (inGrace || (!machine.online && report.status === "unknown")) return { _tag: "connecting" };
  if (machine.online) {
    return {
      _tag: "report",
      overall: report.status === "fail" ? "unknown" : report.status,
      unreachable: "unanswered",
    };
  }
  return { _tag: "report", overall: "fail", unreachable: "offline" };
}

/** "Up 4 days", from the server's uptime in seconds. */
export function uptimeLabel(uptimeSeconds: number): string | null {
  return Number.isFinite(uptimeSeconds) && uptimeSeconds >= 60
    ? `Up ${formatHealthDuration(uptimeSeconds * 1000)}`
    : null;
}

export const CANARY_INTERVAL_OPTIONS: ReadonlyArray<{
  readonly minutes: number;
  readonly label: string;
}> = [
  { minutes: 15, label: "Every 15 minutes" },
  { minutes: 30, label: "Every 30 minutes" },
  { minutes: 60, label: "Every hour" },
  { minutes: 180, label: "Every 3 hours" },
  { minutes: 360, label: "Every 6 hours" },
  { minutes: 1440, label: "Every day" },
];

/** The presets, plus a value saved elsewhere (settings.json, an agent) so the select can show it. */
export function canaryIntervalOptions(current: number): ReadonlyArray<{
  readonly minutes: number;
  readonly label: string;
}> {
  if (CANARY_INTERVAL_OPTIONS.some((option) => option.minutes === current)) {
    return CANARY_INTERVAL_OPTIONS;
  }
  return [
    ...CANARY_INTERVAL_OPTIONS,
    { minutes: current, label: `Every ${formatHealthDuration(current * 60_000)}` },
  ].toSorted((left, right) => left.minutes - right.minutes);
}

export interface AlertChannelIntegration {
  readonly name: string;
  readonly label: string;
  readonly connected: boolean;
}

/**
 * The integrations an alert channel can send through: those connected from
 * one catalog entry (Slack, Google Workspace). The saved name stays listed
 * after its integration is removed, so the select shows what is configured.
 */
export function alertChannelIntegrations(
  integrations: ReadonlyArray<IntegrationSummary>,
  catalogId: IntegrationCatalogId,
  saved: string | null,
): ReadonlyArray<AlertChannelIntegration> {
  const options = integrations
    .filter(
      ({ integration }) =>
        integration.deletedAt === null && integrationCatalogEntryFor(integration)?.id === catalogId,
    )
    .map(({ integration, status }) => {
      const account = integrationAccountLabel(integration);
      return {
        name: integration.name,
        label: account ? `${integration.displayName} (${account})` : integration.displayName,
        connected: status === "connected",
      };
    });
  if (saved !== null && !options.some((option) => option.name === saved)) {
    return [...options, { name: saved, label: `${saved} (removed)`, connected: false }];
  }
  return options;
}

/** One line per channel for a test send. */
export function channelTestLines(result: MachineHealthChannelTestResult): ReadonlyArray<{
  readonly channel: string;
  readonly state: "sent" | "failed" | "skipped";
  readonly text: string;
}> {
  return (
    [
      ["Slack", result.slack],
      ["Email", result.email],
    ] as const
  ).map(([channel, outcome]) =>
    !outcome.attempted
      ? { channel, state: "skipped" as const, text: "Off or not set up, so nothing was sent." }
      : outcome.ok
        ? { channel, state: "sent" as const, text: "Sent." }
        : { channel, state: "failed" as const, text: outcome.error?.trim() || "Couldn't send." },
  );
}

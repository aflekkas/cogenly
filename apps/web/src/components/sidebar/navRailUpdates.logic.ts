import type { ServerUpdateState } from "@cogenly/client-runtime/state/server";
import {
  PROVIDER_DISPLAY_NAMES,
  type DesktopUpdateState,
  type ProviderDriverKind,
  type ServerProvider,
} from "@cogenly/contracts";

import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  isProviderUpdateActive,
} from "../ProviderUpdateLaunchNotification.logic";
import {
  getDesktopUpdateDownloadedVersion,
  resolveDesktopUpdateButtonAction,
} from "../desktopUpdate.logic";

export type UpdateRowStatus = "current" | "available" | "updating" | "failed";

/** One component in the rail's update list. */
export interface UpdateRowView {
  readonly key: string;
  readonly name: string;
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
  readonly status: UpdateRowStatus;
  /** Replaces the status label, e.g. download progress or a failure reason. */
  readonly detail: string | null;
  /** How far an update has got, 0-100, when the updater reports it. */
  readonly percent?: number | null;
}

export interface ProviderUpdateRowView extends UpdateRowView {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ServerProvider["instanceId"];
  /** The server can run this update itself; otherwise it needs a manual install. */
  readonly oneClick: boolean;
}

/**
 * One row per provider driver on a machine: Claude, Codex, Muse Code. Several
 * instances of a driver share its CLI, so they share a row. The server's own
 * update state wins over the version advisory, so a running or failed update
 * shows as such until the server reports otherwise.
 */
export function collectProviderUpdateRows(
  providers: ReadonlyArray<ServerProvider>,
): ProviderUpdateRowView[] {
  const byDriver = new Map<ProviderDriverKind, ServerProvider[]>();
  for (const provider of providers) {
    if (!provider.enabled || !provider.installed || provider.availability === "unavailable") {
      continue;
    }
    byDriver.set(provider.driver, [...(byDriver.get(provider.driver) ?? []), provider]);
  }
  return Array.from(byDriver, ([driver, driverProviders]) => {
    const active = driverProviders.find(isProviderUpdateActive);
    const candidate = collectProviderUpdateCandidates(driverProviders)[0];
    const representative = active ?? candidate ?? driverProviders[0]!;
    const advisory = representative.versionAdvisory;
    const failed = !active && candidate?.updateState?.status === "failed";
    return {
      key: driver,
      driver,
      instanceId: representative.instanceId,
      name: PROVIDER_DISPLAY_NAMES[driver] ?? representative.displayName ?? driver,
      currentVersion: advisory?.currentVersion ?? representative.version,
      latestVersion: candidate ? candidate.versionAdvisory.latestVersion : null,
      status: active ? "updating" : failed ? "failed" : candidate ? "available" : "current",
      detail: failed ? (candidate.updateState?.message ?? null) : null,
      oneClick:
        candidate !== undefined &&
        !active &&
        canOneClickUpdateProviderCandidate(candidate, providers),
    } satisfies ProviderUpdateRowView;
  }).toSorted((left, right) => left.name.localeCompare(right.name));
}

export interface DesktopUpdateRowView extends UpdateRowView {
  /** What the row's button does. "check" retries a failed update check. */
  readonly action: "download" | "install" | "check" | null;
}

/** This app's row, from the desktop updater's state. */
export function describeDesktopUpdateRow(state: DesktopUpdateState): DesktopUpdateRowView {
  const action = resolveDesktopUpdateButtonAction(state);
  const latestVersion = action === "none" ? null : getDesktopUpdateDownloadedVersion(state);
  const base = {
    key: "desktop",
    name: "Cogenly",
    currentVersion: state.currentVersion,
    latestVersion,
  } as const;
  if (state.status === "downloading") {
    const percent =
      typeof state.downloadPercent === "number"
        ? Math.min(100, Math.max(0, state.downloadPercent))
        : null;
    return {
      ...base,
      status: "updating",
      detail: percent === null ? "Downloading…" : `Downloading · ${Math.floor(percent)}%`,
      percent,
      action: null,
    };
  }
  if (state.status === "error") {
    return {
      ...base,
      status: "failed",
      detail: state.message,
      action: action === "none" ? "check" : action,
    };
  }
  if (action === "install") {
    return { ...base, status: "available", detail: "Restart to install", action };
  }
  if (action === "download") {
    return { ...base, status: "available", detail: null, action };
  }
  return { ...base, status: "current", detail: null, action: null };
}

/**
 * The desktop updater state the popover shows. Starting a check resets the
 * updater to "checking", which drops a known update (its version, button and
 * notes) until the check answers, and the popover shrinks and grows back. The
 * last settled state holds through the check instead, so only a real change
 * moves the layout. `settled` is the newest state that was not "checking".
 */
export function holdDesktopUpdateStateWhileChecking(
  current: DesktopUpdateState | null,
  settled: DesktopUpdateState | null,
): DesktopUpdateState | null {
  if (current?.status !== "checking" || !settled) return current;
  // A different build (the app restarted into an update) has nothing to hold.
  if (settled.currentVersion !== current.currentVersion) return current;
  return { ...settled, checkedAt: current.checkedAt };
}

/** This app's row when there is no desktop updater, e.g. in a browser. */
export function describeAppRow(version: string | null): UpdateRowView {
  return {
    key: "app",
    name: "Cogenly",
    currentVersion: version,
    latestVersion: null,
    status: "current",
    detail: null,
  };
}

/**
 * A server's row. `behindVersion` is the version the update pass would move
 * it to. A server shows only while it is behind or updating, unless `always`
 * (the browser app's own server, which stands in for the app).
 */
export function describeServerUpdateRow(input: {
  readonly currentVersion: string | null;
  readonly behindVersion: string | null;
  readonly state: ServerUpdateState;
  readonly name?: string;
  readonly always?: boolean;
}): UpdateRowView | null {
  const { state } = input;
  const base = {
    key: "server",
    name: input.name ?? "Cogenly server",
    currentVersion: input.currentVersion,
  };
  if (state.status === "running") {
    return {
      ...base,
      currentVersion: state.fromVersion,
      latestVersion: state.targetVersion,
      status: "updating",
      detail: null,
    };
  }
  if (state.status === "failed") {
    return {
      ...base,
      currentVersion: state.fromVersion,
      latestVersion: state.targetVersion,
      status: "failed",
      detail: state.message,
    };
  }
  if (input.behindVersion === null) {
    return input.always ? { ...base, latestVersion: null, status: "current", detail: null } : null;
  }
  return { ...base, latestVersion: input.behindVersion, status: "available", detail: null };
}

/** True when the row still needs an update: the count on the rail's badge. */
export function rowNeedsUpdate(row: Pick<UpdateRowView, "status">): boolean {
  return row.status === "available" || row.status === "failed";
}

/** "Claude", "Claude and Codex", "Claude, Codex and 2 more". */
function listNames(names: ReadonlyArray<string>): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

export type UpdatesHeroTone = "current" | "pending" | "busy" | "failed";

/**
 * The popover's one status line, under the app's name: one sentence for the
 * whole state. The app speaks first, then whatever is updating, failed or
 * waiting, by name. It never counts: the rows below already show each one.
 * `components` is one entry per row (a provider across every machine), and
 * `ready` is an app update downloaded and waiting for a restart.
 */
export function describeUpdatesHeroStatus(input: {
  readonly app: Pick<UpdateRowView, "status" | "detail" | "latestVersion">;
  readonly ready: boolean;
  readonly restarting: boolean;
  readonly components: ReadonlyArray<Pick<UpdateRowView, "name" | "status">>;
  readonly checking: boolean;
}): { readonly tone: UpdatesHeroTone; readonly label: string } {
  const { app, components } = input;
  const named = (status: UpdateRowStatus) =>
    listNames(components.filter((row) => row.status === status).map((row) => row.name));
  if (input.restarting) return { tone: "busy", label: "Restarting soon" };
  if (app.status === "updating") return { tone: "busy", label: app.detail ?? "Updating…" };
  if (components.some((row) => row.status === "updating")) {
    return { tone: "busy", label: `Updating ${named("updating")}…` };
  }
  if (input.checking) return { tone: "busy", label: "Checking for updates…" };
  if (app.status === "failed") return { tone: "failed", label: app.detail ?? "Update failed" };
  if (app.status === "available" && app.latestVersion) {
    const version = /^\d/.test(app.latestVersion) ? `v${app.latestVersion}` : app.latestVersion;
    return {
      tone: "pending",
      label: input.ready ? `${version} is ready. Restart to finish.` : `${version} is available`,
    };
  }
  if (components.some((row) => row.status === "failed")) {
    return { tone: "failed", label: `${named("failed")} didn't update` };
  }
  if (components.some((row) => row.status === "available")) {
    return { tone: "pending", label: `Updates for ${named("available")}` };
  }
  return { tone: "current", label: "Everything is up to date" };
}

/** A build suffix worth hiding: "-R6996.1", "-20261027", "+abc". Not "-beta.1" or "-rc.2". */
const BUILD_SUFFIX = /(?:-[A-Za-z]?\d[\w.]*|\+[\w.-]+)$/;

/**
 * The versions a row shows, with build suffixes dropped so "1.4.13-R6996.1 →
 * 1.4.14-R7309.1" reads "1.4.13 → 1.4.14". A pair that differs only in its
 * build keeps them. `shortened` says the full values belong in a tooltip.
 */
export function shortenVersionPair(
  current: string | null,
  next: string | null,
): { readonly current: string | null; readonly next: string | null; readonly shortened: boolean } {
  const short = (version: string | null) => version?.replace(BUILD_SUFFIX, "") ?? null;
  const shortCurrent = short(current);
  const shortNext = short(next);
  if (current && next && current !== next && shortCurrent === shortNext) {
    return { current, next, shortened: false };
  }
  return {
    current: shortCurrent,
    next: shortNext,
    shortened: shortCurrent !== current || shortNext !== next,
  };
}

/** The newest of several "checked at" instants, or null when none parse. */
export function latestCheckedAt(instants: ReadonlyArray<string | null | undefined>): number | null {
  let latest: number | null = null;
  for (const instant of instants) {
    if (!instant) continue;
    const time = Date.parse(instant);
    if (Number.isNaN(time)) continue;
    if (latest === null || time > latest) latest = time;
  }
  return latest;
}

/** "just now", "2 minutes ago", "yesterday"… for the popover's footer. */
export function formatCheckedAgo(checkedAt: number, now: number): string {
  const minutes = Math.floor((now - checkedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

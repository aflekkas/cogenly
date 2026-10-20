import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import {
  PROVIDER_DISPLAY_NAMES,
  type DesktopUpdateState,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";

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

export const UPDATE_ROW_STATUS_LABELS: Record<UpdateRowStatus, string> = {
  current: "Up to date",
  available: "Update available",
  updating: "Updating",
  failed: "Failed",
};

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
      detail: percent === null ? "Downloading" : `Downloading ${Math.floor(percent)}%`,
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

/**
 * The popover header's line: what is updating, else what needs an update.
 * `batch` is every row that has been updating since the popover last saw
 * nothing updating, so "Updating 2 of 3" counts on as rows finish.
 */
export function describeUpdatesSummary(input: {
  readonly rows: ReadonlyArray<Pick<UpdateRowView, "key" | "status">>;
  readonly batchSize: number;
  readonly checking: boolean;
}): string {
  const updating = input.rows.filter((row) => row.status === "updating").length;
  if (updating > 0) {
    const total = Math.max(input.batchSize, updating);
    return total === 1 ? "Updating…" : `Updating ${total - updating + 1} of ${total}…`;
  }
  if (input.checking) return "Checking…";
  const needed = input.rows.filter(rowNeedsUpdate).length;
  if (needed > 0) return `${needed} ${needed === 1 ? "update" : "updates"} available`;
  return "Everything is up to date";
}

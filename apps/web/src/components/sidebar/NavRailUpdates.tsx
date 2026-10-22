/**
 * The rail's Updates button, below Settings. It is always there: quiet at
 * rest, with a blue dot when this app, a server or a provider CLI (Claude,
 * Codex, Muse Code) on any machine has an update. Hovering or focusing it
 * previews the popover; clicking pins it open.
 *
 * The popover leads with this app: its version and one status line for
 * everything, with the app's update as the only filled button. What's new
 * sits under it, then each machine's server and provider CLIs, quiet unless
 * one needs an update, and a footer with when it was all last checked and
 * the action to update everything. The release history opens in the same
 * frame.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { CheckIcon, DownloadIcon, LaptopMinimalIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { APP_VERSION } from "~/branding";
import { isElectron } from "~/env";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { useCogenlyReleases } from "~/state/cogenlyReleases";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  canCheckForUpdate,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateReleaseHistoryUrl,
  resolveDesktopUpdateButtonAction,
  shouldShowLocalDesktopUpdateControl,
} from "../desktopUpdate.logic";
import { useServerUpdate } from "../ServerUpdateAction";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { RefreshIcon } from "../ui/refresh-icon";
import { Separator } from "../ui/separator";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  GitHubLink,
  ReleaseHistoryView,
  type ReleaseTone,
  WhatsNewNotes,
} from "./NavRailReleaseNotes";
import {
  collectProviderUpdateRows,
  describeAppRow,
  describeDesktopUpdateRow,
  describeServerUpdateRow,
  describeUpdatesFooter,
  describeUpdatesHeroStatus,
  formatCheckedAgo,
  latestCheckedAt,
  type ProviderUpdateRowView,
  rowNeedsUpdate,
  type UpdatesHeroTone,
  type UpdateRowView,
} from "./navRailUpdates.logic";
import {
  type CogenlyRelease,
  compareReleaseVersions,
  releaseHistory,
  releasesBetween,
} from "./releaseNotes.logic";
import {
  checkForLocalUpdate,
  confirmAndInstallLocalUpdate,
  downloadLocalUpdate,
  restartIntoPostponedUpdate,
  runUpdateEverythingPass,
} from "./SidebarUpdatePill";
import { BadgeDot } from "../ui/badge-dot";
import { UpdateEverythingDialog } from "./UpdateEverythingDialog";
import { postponeUpdateRestart, useUpdateEverythingRun } from "./updateEverythingRun";
import { useUpdateEverything } from "./useUpdateEverything";

/** How long a finished row shows its check before settling back to quiet. */
const UPDATED_CHECK_MS = 2_400;
/** Hover preview: wait this long before opening, and this long after leaving. */
const HOVER_OPEN_DELAY_MS = 150;
const HOVER_CLOSE_DELAY_MS = 200;

/** "v0.1.2 → v0.1.3" with the incoming version in the foreground; `v` for the app only. */
function VersionPair({
  current,
  next,
  prefix,
  className,
}: {
  current: string | null;
  next: string | null;
  prefix: boolean;
  className?: string;
}) {
  const format = (version: string) => (prefix && /^\d/.test(version) ? `v${version}` : version);
  const from = current ?? next;
  if (!from) return null;
  const to = current && next && current !== next ? next : null;
  return (
    <span className={cn("text-xs text-muted-foreground tabular-nums", className)}>
      {format(from)}
      {to ? (
        <>
          <span aria-label=" to " className="mx-0.75 opacity-70">
            →
          </span>
          <span className="text-foreground">{format(to)}</span>
        </>
      ) : null}
    </span>
  );
}

/** A 2px progress line laid over the bottom of its row, so it takes no room. */
function ProgressLine({
  percent,
  label,
  className,
}: {
  percent: number | null;
  label: string;
  className: string;
}) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(percent === null ? {} : { "aria-valuenow": Math.floor(percent) })}
      className={cn(
        "reveal-motion pointer-events-none absolute h-0.5 overflow-hidden rounded-full bg-muted",
        className,
      )}
    >
      {percent === null ? (
        <div
          ref={observeVisibleAnimation}
          className="update-progress-indeterminate absolute inset-y-0 left-0 w-1/3 rounded-full bg-foreground/80"
        />
      ) : (
        <div
          className="h-full origin-left rounded-full bg-foreground/80 transition-transform duration-(--motion-duration-base) ease-standard motion-reduce:transition-none"
          style={{ transform: `scaleX(${Math.max(0.02, percent / 100)})` }}
        />
      )}
    </div>
  );
}

function HeroStatus({ tone, label }: { tone: UpdatesHeroTone; label: string }) {
  return (
    // Keyed by state so each new status fades in place instead of snapping.
    <span
      key={`${tone}:${label}`}
      aria-live="polite"
      className={cn(
        "swap-motion flex min-w-0 items-center gap-1.25 text-xs tabular-nums",
        tone === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
      )}
    >
      {tone === "current" ? (
        <CheckIcon
          aria-hidden
          className="size-3 shrink-0 text-success-foreground"
          strokeWidth={2.5}
        />
      ) : tone === "pending" ? (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
      ) : null}
      <span className="line-clamp-2 break-words">{label}</span>
    </span>
  );
}

function RowIcon({ row }: { row: UpdateRowView }) {
  if ("driver" in row) {
    const provider = row as ProviderUpdateRowView;
    return (
      <ProviderInstanceIcon
        driverKind={provider.driver}
        displayName={provider.name}
        className="size-5 shrink-0"
        iconClassName="size-4"
      />
    );
  }
  return (
    <img
      src="/cogenly-mark.svg"
      alt=""
      aria-hidden
      draggable={false}
      className="size-5 shrink-0 rounded-tile"
    />
  );
}

/**
 * A server or provider row: name and version, nothing else while it is up to
 * date (a faint check on hover). One that needs an update shows the version
 * it moves to and its button; one updating, a spinner and a progress line.
 */
function ListRow({
  row,
  updated,
  action,
}: {
  row: UpdateRowView;
  /** Just finished updating: shows a check for a moment. */
  updated: boolean;
  action: ReactNode;
}) {
  const justUpdated = updated && row.status === "current";
  const failure = row.status === "failed" ? row.detail : null;
  const trail = justUpdated ? (
    <span
      key="updated"
      className="swap-motion flex items-center gap-1 text-xs text-success-foreground"
    >
      <CheckIcon aria-hidden className="size-3" strokeWidth={2.5} />
      Updated
    </span>
  ) : row.status === "updating" ? (
    <span
      key="updating"
      className="swap-motion flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
    >
      <Spinner size="xs" tone="muted" aria-hidden role={undefined} />
      {row.detail ?? "Updating"}
    </span>
  ) : action ? (
    <span key={`action:${row.status}`} className="swap-motion flex">
      {action}
    </span>
  ) : row.status === "failed" ? (
    <span key="failed" className="swap-motion text-xs text-destructive-foreground">
      Failed
    </span>
  ) : (
    <CheckIcon
      key="current"
      aria-hidden
      className="size-3 text-muted-foreground opacity-0 transition-opacity duration-(--motion-duration-fast) ease-standard group-hover/row:opacity-55"
      strokeWidth={2.5}
    />
  );
  return (
    <div className="reveal-motion flex flex-col">
      <div
        className={cn(
          "group/row relative -mx-1.5 flex h-7.5 items-center gap-2 rounded-md px-1.5 transition-colors duration-(--motion-duration-fast) ease-standard hover:bg-accent",
          rowNeedsUpdate(row) && "bg-muted/48",
        )}
      >
        <RowIcon row={row} />
        <span className="shrink-0 text-menu font-medium">{row.name}</span>
        <VersionPair
          current={row.currentVersion}
          next={row.latestVersion}
          prefix={false}
          className="min-w-0 truncate"
        />
        <span className="flex-1" />
        <span className="flex shrink-0 items-center">{trail}</span>
        {row.status === "updating" ? (
          <ProgressLine
            percent={row.percent ?? null}
            label={`Updating ${row.name}`}
            className="right-1.5 bottom-0 left-8.5"
          />
        ) : null}
      </div>
      {failure ? (
        <p className="reveal-motion pt-0.5 pb-1.5 pl-7 text-xs break-words text-muted-foreground">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

function RowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button size="xs" variant="outline" onClick={onClick}>
      {label}
    </Button>
  );
}

function RefreshButton({ checking, onCheck }: { checking: boolean; onCheck: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={checking ? "Checking for updates" : "Check for updates"}
            aria-busy={checking}
            disabled={checking}
            onClick={onCheck}
          >
            <RefreshIcon refreshing={checking} />
          </Button>
        }
      />
      <TooltipPopup side="top">
        {checking ? "Checking for updates…" : "Check for updates"}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The hero's one action: the app's update. Only "Update & restart" and friends are filled. */
interface HeroAction {
  readonly label: string;
  readonly filled: boolean;
  /** Null while the update it starts is already running. */
  readonly onClick: (() => void) | null;
}

interface MachineGroup {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly server: UpdateRowView | null;
  readonly providers: ReadonlyArray<ProviderUpdateRowView>;
}

interface TrackedRow {
  readonly id: string;
  readonly row: UpdateRowView;
}

/**
 * Follows rows across renders: which ones have updated since nothing was
 * updating (the header's "Updating 2 of 3"), and which just finished, to show
 * their check. A row that leaves the list as it finishes (a server once it is
 * caught up) stays for its check as an up-to-date ghost.
 */
function useUpdateTransitions(rows: ReadonlyArray<TrackedRow>) {
  const [batch, setBatch] = useState<ReadonlySet<string>>(() => new Set());
  const [updated, setUpdated] = useState<ReadonlyMap<string, UpdateRowView>>(() => new Map());
  const previous = useRef<ReadonlyMap<string, UpdateRowView>>(new Map());
  const timers = useRef(new Map<string, number>());
  const signature = rows.map(({ id, row }) => `${id}=${row.status}`).join("|");

  useEffect(() => {
    const current = new Map(rows.map(({ id, row }) => [id, row]));
    const updating = rows.filter(({ row }) => row.status === "updating").map(({ id }) => id);
    const finished = [...previous.current].filter(([id, row]) => {
      if (row.status !== "updating") return false;
      const next = current.get(id);
      return next === undefined || next.status === "current";
    });
    previous.current = current;
    setBatch((last) => {
      if (updating.length === 0) return last.size === 0 ? last : new Set();
      if (updating.every((id) => last.has(id))) return last;
      return new Set([...last, ...updating]);
    });
    if (finished.length === 0) return;
    setUpdated((last) => {
      const next = new Map(last);
      for (const [id, row] of finished) {
        next.set(id, {
          ...row,
          status: "current",
          detail: null,
          percent: null,
          currentVersion: row.latestVersion ?? row.currentVersion,
          latestVersion: null,
        });
      }
      return next;
    });
    for (const [id] of finished) {
      window.clearTimeout(timers.current.get(id));
      timers.current.set(
        id,
        window.setTimeout(() => {
          timers.current.delete(id);
          setUpdated((last) => {
            const next = new Map(last);
            next.delete(id);
            return next;
          });
        }, UPDATED_CHECK_MS),
      );
    }
    // `signature` captures every status change; rows itself is rebuilt each render.
  }, [signature]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
    };
  }, []);

  return { batchSize: batch.size, updated };
}

export function NavRailUpdates({
  buttonClassName,
}: {
  /** The rail's button look, active while the popover is pinned open. */
  buttonClassName: (active: boolean) => string;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // Pinned by a click (or by using a control inside); a hover preview is not.
  const [pinned, setPinned] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  // The popover's main list, or the release history sub-view.
  const [view, setView] = useState<"updates" | "releases">("updates");
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [checking, setChecking] = useState(false);
  const [desktopPending, setDesktopPending] = useState(false);
  const [pendingProviders, setPendingProviders] = useState<ReadonlySet<string>>(() => new Set());
  const [providerErrors, setProviderErrors] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );

  const desktopState = useDesktopUpdateState();
  const desktopAction = desktopState ? resolveDesktopUpdateButtonAction(desktopState) : "none";
  const isDownloading = desktopState?.status === "downloading";
  // Remote servers follow this app to the version it is about to install.
  const localUpdateVersion =
    desktopState && desktopAction !== "none"
      ? getDesktopUpdateDownloadedVersion(desktopState)
      : null;
  const everything = useUpdateEverything(localUpdateVersion);
  const run = useUpdateEverythingRun();
  const updateServer = useServerUpdate();
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const { environments } = useEnvironments();
  const connected = useMemo(
    () => environments.filter((environment) => environment.connection.phase === "connected"),
    [environments],
  );
  const serverStatesAtom = useMemo(
    () =>
      Atom.make((get) =>
        connected.map((environment): ServerUpdateState =>
          get(serverEnvironment.updateStateAtom(environment.environmentId)),
        ),
      ),
    [connected],
  );
  const serverStates = useAtomValue(serverStatesAtom);

  // In a browser there is no desktop updater: the first machine's server
  // serves this app, so its row stands in for Cogenly and always shows.
  const desktopRow =
    isElectron && desktopState && shouldShowLocalDesktopUpdateControl(desktopState)
      ? describeDesktopUpdateRow(desktopState)
      : null;
  const serverIsAppRow = !isElectron;

  const builtGroups: MachineGroup[] = connected.flatMap((environment, index) => {
    const target = everything.servers.find(
      (server) => server.environmentId === environment.environmentId,
    );
    const isAppRow = serverIsAppRow && index === 0;
    const server = describeServerUpdateRow({
      currentVersion: environment.serverConfig?.environment.serverVersion ?? null,
      behindVersion: target?.targetVersion ?? null,
      state: serverStates[index] ?? { status: "idle" },
      ...(isAppRow ? { name: "Cogenly", always: true } : {}),
    });
    const providers = collectProviderUpdateRows(environment.serverConfig?.providers ?? []).map(
      (row): ProviderUpdateRowView => {
        const key = `${environment.environmentId}:${row.key}`;
        if (pendingProviders.has(key)) return { ...row, status: "updating", detail: null };
        const error = providerErrors.get(key);
        return error !== undefined ? { ...row, status: "failed", detail: error } : row;
      },
    );
    return [
      { environmentId: environment.environmentId, label: environment.label, server, providers },
    ];
  });
  const shownDesktopRow =
    desktopRow && desktopPending && desktopRow.status !== "updating"
      ? { ...desktopRow, status: "updating" as const }
      : desktopRow;
  // Always a Cogenly row: the desktop updater's; in a browser, the server that
  // serves this app; else this build's version.
  const appServerGroup = serverIsAppRow ? (builtGroups[0] ?? null) : null;
  const appRow: UpdateRowView =
    shownDesktopRow ??
    appServerGroup?.server ??
    describeAppRow(desktopState?.currentVersion ?? APP_VERSION);
  const appRowId = appServerGroup?.server ? `${appServerGroup.environmentId}:server` : appRow.key;

  const tracked: TrackedRow[] = [
    { id: appRowId, row: appRow },
    ...builtGroups.flatMap((group) => [
      ...(group.server && group !== appServerGroup
        ? [{ id: `${group.environmentId}:server`, row: group.server }]
        : []),
      ...group.providers.map((row) => ({ id: `${group.environmentId}:${row.key}`, row })),
    ]),
  ];
  const { batchSize, updated } = useUpdateTransitions(tracked);
  const groups = builtGroups
    .map((group) => {
      if (group === appServerGroup) return { ...group, server: null };
      const ghost = updated.get(`${group.environmentId}:server`);
      return group.server === null && ghost ? { ...group, server: ghost } : group;
    })
    .filter((group) => group.server !== null || group.providers.length > 0);

  const updateCount = tracked.filter(({ row }) => rowNeedsUpdate(row)).length;
  const updateLabel = `${updateCount} ${updateCount === 1 ? "update" : "updates"} available`;
  const isChecking = checking || desktopState?.status === "checking";
  const anyUpdating = tracked.some(({ row }) => row.status === "updating");

  // This app's restart countdown can be postponed, so it stays in view.
  const countdown = run?.phase === "countdown";
  const restarting = countdown && run?.restartAt != null;
  const popoverOpen = open || countdown;

  const releasesSnapshot = useCogenlyReleases(popoverOpen);
  const releases = releasesSnapshot.releases ?? [];
  const installedVersion = appRow.currentVersion;
  // What the app's pending update brings, while there is one to take.
  const incomingReleases =
    appRow.latestVersion && appRow.status !== "current"
      ? releasesBetween(releases, installedVersion, appRow.latestVersion)
      : [];
  const installedHistory = releaseHistory(releases, installedVersion);
  const history = [
    ...incomingReleases,
    ...installedHistory.filter(
      (release) => !incomingReleases.some((incoming) => incoming.version === release.version),
    ),
  ];
  const notesReleases =
    incomingReleases.length > 0 ? incomingReleases : installedHistory.slice(0, 1);
  const releaseTone = (release: CogenlyRelease): ReleaseTone => {
    if (incomingReleases.includes(release)) return "available";
    if (release.version === installedVersion) return "installed";
    if (installedVersion && compareReleaseVersions(release.version, installedVersion) < 0) {
      return "older";
    }
    return "plain";
  };

  // "Checked 2 minutes ago": the newest check of this app and every provider.
  // A minute clock, so the label keeps counting while the popover is open.
  const nowMinute = useNowMinute();
  const checkedAt = latestCheckedAt([
    desktopState?.checkedAt,
    ...connected.flatMap((environment) =>
      (environment.serverConfig?.providers ?? []).map(
        (provider) => provider.versionAdvisory?.checkedAt ?? provider.checkedAt,
      ),
    ),
  ]);
  const checkedAgo =
    checkedAt === null
      ? null
      : formatCheckedAgo(checkedAt, Math.max(Date.parse(`${nowMinute}:00Z`), checkedAt));

  const closePopover = () => {
    setOpen(false);
    setPinned(false);
  };

  const runDesktopAction = (action: "download" | "install" | "check") => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopState || desktopPending) return;
    setDesktopPending(true);
    const pending =
      action === "download"
        ? downloadLocalUpdate(bridge, { notifyDownloaded: true })
        : action === "install"
          ? // After a postponed restart, keep the servers still restarting followed.
            run !== null && run.localVersion === null
            ? restartIntoPostponedUpdate(bridge, localUpdateVersion)
            : confirmAndInstallLocalUpdate(bridge, desktopState)
          : checkForLocalUpdate(bridge);
    void pending.finally(() => setDesktopPending(false));
  };

  const runProviderUpdate = async (environmentId: EnvironmentId, row: ProviderUpdateRowView) => {
    const key = `${environmentId}:${row.key}`;
    if (pendingProviders.has(key)) return;
    const setError = (message: string | null) =>
      setProviderErrors((previous) => {
        const next = new Map(previous);
        if (message === null) next.delete(key);
        else next.set(key, message);
        return next;
      });
    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) {
      setError("This connection cannot manage providers.");
      return;
    }
    setError(null);
    setPendingProviders((previous) => new Set(previous).add(key));
    const result = await updateProvider({
      environmentId,
      input: { provider: row.driver, instanceId: row.instanceId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setError(error instanceof Error ? error.message : "Provider update failed.");
    }
    setPendingProviders((previous) => {
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
  };

  const checkForUpdates = async () => {
    if (checking) return;
    setChecking(true);
    const bridge = window.desktopBridge;
    await Promise.all([
      bridge && canCheckForUpdate(desktopState) ? checkForLocalUpdate(bridge) : null,
      ...connected
        .filter((environment) =>
          readEnvironmentScope(environment.environmentId, AuthOrchestrationReadScope),
        )
        .map((environment) =>
          refreshProviders({ environmentId: environment.environmentId, input: {} }),
        ),
    ]);
    setChecking(false);
  };

  // "Update all" earns its place beside the hero's and the rows' own buttons
  // only when there is more than one update to take.
  const canUpdateAll =
    run === null &&
    updateCount > 1 &&
    ((everything.hasUpdates && !isDownloading) || desktopAction !== "none");
  const updateAll = () => {
    if (everything.hasUpdates && !isDownloading) {
      setConfirmingAll(true);
    } else if (desktopAction !== "none") {
      runDesktopAction(desktopAction);
    }
  };

  const openProviderSettings = () => {
    closePopover();
    void navigate({ to: "/settings/providers" });
  };

  const providerAction = (group: MachineGroup, row: ProviderUpdateRowView) => {
    if (row.status !== "available" && row.status !== "failed") return null;
    if (!row.oneClick) return <RowButton label="Settings" onClick={openProviderSettings} />;
    return (
      <RowButton
        label={row.status === "failed" ? "Retry" : "Update"}
        onClick={() => void runProviderUpdate(group.environmentId, row)}
      />
    );
  };

  const serverTarget = (group: MachineGroup) =>
    everything.servers.find((server) => server.environmentId === group.environmentId);

  const serverAction = (group: MachineGroup, row: UpdateRowView) => {
    const target = serverTarget(group);
    if (!target || (row.status !== "available" && row.status !== "failed")) return null;
    return (
      <RowButton
        label={row.status === "failed" ? "Retry" : "Update"}
        onClick={() => void updateServer(target)}
      />
    );
  };

  // The app's update is the hero's one button. It stays, disabled, while the
  // update runs, so the hero holds its shape from the click to the restart.
  const heroAction = ((): HeroAction | null => {
    if (shownDesktopRow) {
      if (countdown || shownDesktopRow.status === "updating") {
        return { label: "Update & restart", filled: false, onClick: null };
      }
      const action = shownDesktopRow.action;
      if (!action) return null;
      const onClick = () => runDesktopAction(action);
      if (shownDesktopRow.status === "failed") return { label: "Retry", filled: false, onClick };
      return action === "install"
        ? { label: "Update & restart", filled: true, onClick }
        : { label: "Download", filled: true, onClick };
    }
    if (appServerGroup && appServerGroup.server) {
      const row = appServerGroup.server;
      if (row.status === "updating") return { label: "Update", filled: false, onClick: null };
      const target = serverTarget(appServerGroup);
      if (!target || (row.status !== "available" && row.status !== "failed")) return null;
      const onClick = () => void updateServer(target);
      return row.status === "failed"
        ? { label: "Retry", filled: false, onClick }
        : { label: "Update", filled: true, onClick };
    }
    return null;
  })();

  const heroStatus = describeUpdatesHeroStatus({
    app: appRow,
    ready: shownDesktopRow?.action === "install",
    restarting,
    rows: tracked.map(({ row }) => row),
    batchSize,
    checking: isChecking,
  });
  const footerText = describeUpdatesFooter({
    app: restarting ? { status: "updating" } : appRow,
    rows: tracked.map(({ row }) => row),
    batchSize,
    checkedAgo,
  });
  const historyUrl = getDesktopUpdateReleaseHistoryUrl();
  // The refresh button lives in the hero until the hero has an action to
  // offer; then it moves down beside "Update all".
  const refreshInHero = heroAction === null;
  const footerActions = [
    countdown ? (
      <Button key="later" size="xs" variant="ghost-muted" onClick={postponeUpdateRestart}>
        Later
      </Button>
    ) : null,
    !refreshInHero && !anyUpdating && !countdown ? (
      <RefreshButton key="refresh" checking={isChecking} onCheck={() => void checkForUpdates()} />
    ) : null,
    canUpdateAll ? (
      <Button key="all" size="xs" variant="outline" onClick={updateAll}>
        Update all
      </Button>
    ) : null,
  ].filter((action) => action !== null);

  const showReleases = () => {
    setPinned(true);
    setView("releases");
  };
  const appUpdating = appRow.status === "updating" || restarting;
  const hasNotes = notesReleases.length > 0;

  return (
    <>
      <Popover
        open={popoverOpen}
        onOpenChange={(next, details) => {
          if (next) {
            // Each opening starts on the update list, not the last sub-view.
            if (!popoverOpen) setView("updates");
            setOpen(true);
            if (details.reason === "trigger-press") setPinned(true);
            return;
          }
          // A click on a hover preview pins it rather than closing it.
          if (details.reason === "trigger-press" && !pinned) {
            setPinned(true);
            return;
          }
          // Once pinned, only an outside click, Escape or the button closes it.
          if (pinned && (details.reason === "trigger-hover" || details.reason === "focus-out")) {
            return;
          }
          closePopover();
        }}
      >
        <PopoverTrigger
          openOnHover
          delay={HOVER_OPEN_DELAY_MS}
          closeDelay={HOVER_CLOSE_DELAY_MS}
          render={
            <button
              type="button"
              aria-label={updateCount > 0 ? `Updates, ${updateLabel}` : "Updates"}
              className={buttonClassName(pinned || countdown)}
              onClick={() => {
                // A click on an open preview pins it (the popover may not report it).
                if (open && !pinned) setPinned(true);
              }}
              onFocus={(event) => {
                // Keyboard focus previews it, as hovering does.
                if (!popoverOpen && event.currentTarget.matches(":focus-visible")) setOpen(true);
              }}
              onBlur={(event) => {
                if (pinned || popupRef.current?.contains(event.relatedTarget as Node | null)) {
                  return;
                }
                setOpen(false);
              }}
            >
              <DownloadIcon aria-hidden />
              <BadgeDot
                tone={updateCount > 0 && "info"}
                size="md"
                ring="nav-rail"
                className="absolute top-2 right-2"
              />
            </button>
          }
        />
        <PopoverPopup
          side="right"
          align="end"
          width="lg"
          padding="compact"
          aria-label="Updates"
          // A preview leaves focus on the rail; a pinned popover takes it.
          initialFocus={pinned}
        >
          <div
            ref={popupRef}
            className="flex flex-col pt-0.5"
            // Using anything inside a preview pins it, so it stays while the
            // pointer wanders off to watch the update.
            onPointerDownCapture={() => setPinned(true)}
            onKeyDownCapture={(event) => {
              if (event.key === "Enter" || event.key === " ") setPinned(true);
            }}
          >
            {view === "releases" ? (
              <ReleaseHistoryView
                snapshot={releasesSnapshot}
                releases={history}
                toneOf={releaseTone}
                historyUrl={historyUrl}
                onBack={() => setView("updates")}
              />
            ) : (
              <div key="updates" className="swap-motion flex flex-col">
                <div className="relative flex items-center gap-2.5 pt-0.5 pb-2">
                  <img
                    src="/cogenly-mark.svg"
                    alt=""
                    aria-hidden
                    draggable={false}
                    className="size-8 shrink-0 rounded-tile select-none"
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-px">
                    <div className="flex min-w-0 items-baseline gap-1.5">
                      <span className="shrink-0 text-sm font-medium">{appRow.name}</span>
                      <VersionPair
                        current={appRow.currentVersion}
                        next={appRow.status === "current" ? null : appRow.latestVersion}
                        prefix
                        className="min-w-0 truncate"
                      />
                    </div>
                    <HeroStatus tone={heroStatus.tone} label={heroStatus.label} />
                  </div>
                  <div
                    key={heroAction ? `action:${heroAction.label}` : "refresh"}
                    className="swap-motion flex shrink-0 items-center gap-1"
                  >
                    {heroAction ? (
                      <Button
                        size="xs"
                        variant={heroAction.filled ? "default" : "outline"}
                        disabled={heroAction.onClick === null}
                        onClick={heroAction.onClick ?? undefined}
                      >
                        {heroAction.label}
                      </Button>
                    ) : (
                      <RefreshButton checking={isChecking} onCheck={() => void checkForUpdates()} />
                    )}
                  </div>
                  {appUpdating ? (
                    <ProgressLine
                      percent={restarting ? null : (appRow.percent ?? null)}
                      label={`Updating ${appRow.name}`}
                      className="right-0 bottom-0.5 left-10.5"
                    />
                  ) : null}
                </div>
                {hasNotes ? (
                  <>
                    <Separator />
                    <WhatsNewNotes
                      // A new set of notes (the update arrived, or was installed) fades in anew.
                      key={notesReleases.map((release) => release.version).join(",")}
                      releases={notesReleases}
                      pending={incomingReleases.length > 0}
                      hasEarlier={history.length > notesReleases.length}
                      onShowHistory={showReleases}
                    />
                  </>
                ) : null}
                {groups.length > 0 || connected.length === 0 ? <Separator /> : null}
                {groups.map((group, index) => (
                  <section
                    key={group.environmentId}
                    aria-label={`Providers on ${group.label}`}
                    className="flex flex-col pt-2"
                  >
                    <div className="flex h-5 items-baseline justify-between gap-2">
                      <span className="text-2xs font-medium text-muted-foreground select-none">
                        {index === 0 ? "Providers" : null}
                      </span>
                      <span className="inline-flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
                        <LaptopMinimalIcon aria-hidden className="size-2.75 shrink-0" />
                        <span className="truncate">{group.label}</span>
                      </span>
                    </div>
                    {group.server ? (
                      <ListRow
                        row={group.server}
                        updated={updated.has(`${group.environmentId}:server`)}
                        action={serverAction(group, group.server)}
                      />
                    ) : null}
                    {group.providers.map((row) => (
                      <ListRow
                        key={row.key}
                        row={row}
                        updated={updated.has(`${group.environmentId}:${row.key}`)}
                        action={providerAction(group, row)}
                      />
                    ))}
                  </section>
                ))}
                {connected.length === 0 ? (
                  <span className="pt-2 text-xs text-muted-foreground">
                    No connected machines to check.
                  </span>
                ) : null}
                <div className="mt-2 flex min-h-6 items-center justify-between gap-2 border-t pt-2">
                  <span
                    key={footerText}
                    className="swap-motion min-w-0 truncate text-2xs text-muted-foreground tabular-nums"
                  >
                    {footerText}
                  </span>
                  {footerActions.length > 0 ? (
                    <div className="reveal-motion flex shrink-0 items-center gap-1.5">
                      {footerActions}
                    </div>
                  ) : historyUrl ? (
                    <GitHubLink href={historyUrl}>All releases on GitHub</GitHubLink>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </PopoverPopup>
      </Popover>
      <UpdateEverythingDialog
        open={confirmingAll}
        onOpenChange={setConfirmingAll}
        summary={everything.summary}
        lines={everything.lines}
        restarts={everything.restarts}
        skipped={everything.skipped}
        onConfirm={() => {
          setConfirmingAll(false);
          closePopover();
          void runUpdateEverythingPass(everything, desktopAction);
        }}
      />
    </>
  );
}

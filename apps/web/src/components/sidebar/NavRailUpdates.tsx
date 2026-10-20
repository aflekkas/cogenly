/**
 * The rail's Updates button, below Settings. It is always there: quiet at
 * rest, with a blue dot when this app, a server or a provider CLI (Claude,
 * Codex, Muse Code) on any machine has an update. Hovering or focusing it
 * previews the popover; clicking pins it open. The popover lists this app,
 * each server and each provider CLI with its version and status, shows each
 * update's progress in its row, and updates one or all of them through the
 * same actions as the sidebar update button.
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
import { CheckIcon, DownloadIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { APP_VERSION } from "~/branding";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  canCheckForUpdate,
  getDesktopUpdateDownloadedVersion,
  resolveDesktopUpdateButtonAction,
  shouldShowLocalDesktopUpdateControl,
} from "../desktopUpdate.logic";
import { useServerUpdate } from "../ServerUpdateAction";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  collectProviderUpdateRows,
  describeAppRow,
  describeDesktopUpdateRow,
  describeServerUpdateRow,
  describeUpdatesSummary,
  type ProviderUpdateRowView,
  rowNeedsUpdate,
  UPDATE_ROW_STATUS_LABELS,
  type UpdateRowStatus,
  type UpdateRowView,
} from "./navRailUpdates.logic";
import {
  checkForLocalUpdate,
  confirmAndInstallLocalUpdate,
  downloadLocalUpdate,
  restartIntoPostponedUpdate,
  runUpdateEverythingPass,
} from "./SidebarUpdatePill";
import { UpdateEverythingDialog } from "./UpdateEverythingDialog";
import { postponeUpdateRestart, useUpdateEverythingRun } from "./updateEverythingRun";
import { useUpdateEverything } from "./useUpdateEverything";

/** How long a finished row shows its check before settling on "Up to date". */
const UPDATED_CHECK_MS = 2_400;
/** Hover preview: wait this long before opening, and this long after leaving. */
const HOVER_OPEN_DELAY_MS = 150;
const HOVER_CLOSE_DELAY_MS = 200;

function formatVersion(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version;
}

function versionLabel(row: UpdateRowView): string | null {
  const { currentVersion, latestVersion } = row;
  if (currentVersion && latestVersion && currentVersion !== latestVersion) {
    return `${formatVersion(currentVersion)} → ${formatVersion(latestVersion)}`;
  }
  const version = currentVersion ?? latestVersion;
  return version ? formatVersion(version) : null;
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

/** A thin bar under an updating row: the real percentage when the updater
    reports one, else a sweeping segment. */
function RowProgress({ percent, label }: { percent: number | null; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(percent === null ? {} : { "aria-valuenow": Math.floor(percent) })}
      className="reveal-motion relative mb-1.5 ml-7.5 h-0.5 overflow-hidden rounded-full bg-muted"
    >
      {percent === null ? (
        <div
          ref={observeVisibleAnimation}
          className="update-progress-indeterminate absolute inset-y-0 left-0 w-1/3 rounded-full bg-info"
        />
      ) : (
        <div
          className="h-full origin-left rounded-full bg-info transition-transform duration-(--motion-duration-base) ease-standard motion-reduce:transition-none"
          style={{ transform: `scaleX(${Math.max(0.02, percent / 100)})` }}
        />
      )}
    </div>
  );
}

type RowDisplayStatus = UpdateRowStatus | "updated";

const STATUS_TONE: Record<RowDisplayStatus, string> = {
  current: "text-muted-foreground",
  available: "text-info-foreground",
  updating: "text-muted-foreground",
  failed: "text-destructive-foreground",
  updated: "text-success-foreground",
};

function RowStatus({ status, label }: { status: RowDisplayStatus; label: string }) {
  return (
    // Keyed by state so each new status rises into place instead of snapping.
    <span
      key={`${status}:${label}`}
      className={cn(
        "swap-motion flex items-center gap-1 text-xs whitespace-nowrap tabular-nums",
        STATUS_TONE[status],
      )}
    >
      {status === "updating" ? (
        <Spinner size="xs" tone="muted" aria-hidden role={undefined} />
      ) : null}
      {status === "updated" ? <CheckIcon aria-hidden className="size-3.5" /> : null}
      {label}
    </span>
  );
}

function UpdateRow({
  row,
  updated,
  action,
}: {
  row: UpdateRowView;
  /** Just finished updating: shows a check for a moment. */
  updated: boolean;
  action?: ReactNode;
}) {
  const versions = versionLabel(row);
  const status: RowDisplayStatus = updated && row.status === "current" ? "updated" : row.status;
  const label =
    status === "updated"
      ? "Updated"
      : status === "updating"
        ? (row.detail ?? UPDATE_ROW_STATUS_LABELS.updating)
        : UPDATE_ROW_STATUS_LABELS[row.status];
  const failure = row.status === "failed" ? row.detail : null;
  return (
    <div className="reveal-motion flex flex-col">
      <div className="flex h-9 items-center gap-2.5">
        <RowIcon row={row} />
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 text-sm font-medium">{row.name}</span>
          {versions ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">
              {versions}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <RowStatus status={status} label={label} />
          {action}
        </div>
      </div>
      {row.status === "updating" ? (
        <RowProgress percent={row.percent ?? null} label={`Updating ${row.name}`} />
      ) : null}
      {failure ? (
        <p className="reveal-motion pb-1.5 pl-7.5 text-xs break-words text-muted-foreground">
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
  const summary = describeUpdatesSummary({
    rows: tracked.map(({ row }) => row),
    batchSize,
    checking: isChecking,
  });

  // This app's restart countdown can be postponed, so it stays in view.
  const countdown = run?.phase === "countdown";
  const popoverOpen = open || countdown;

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

  const canUpdateAll =
    run === null &&
    updateCount > 0 &&
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

  const serverAction = (group: MachineGroup, row: UpdateRowView) => {
    const target = everything.servers.find(
      (server) => server.environmentId === group.environmentId,
    );
    if (!target || (row.status !== "available" && row.status !== "failed")) return null;
    return (
      <RowButton
        label={row.status === "failed" ? "Retry" : "Update"}
        onClick={() => void updateServer(target)}
      />
    );
  };

  const desktopRowAction = countdown ? (
    <RowButton label="Later" onClick={postponeUpdateRestart} />
  ) : shownDesktopRow?.action && shownDesktopRow.status !== "updating" ? (
    <RowButton
      label={
        shownDesktopRow.status === "failed"
          ? "Retry"
          : shownDesktopRow.action === "install"
            ? "Restart"
            : "Update"
      }
      onClick={() => runDesktopAction(shownDesktopRow.action!)}
    />
  ) : null;
  const shownAppRow =
    countdown && run?.restartAt != null
      ? { ...appRow, status: "updating" as const, detail: "Restarting soon", percent: null }
      : appRow;
  const appRowAction = desktopRow
    ? desktopRowAction
    : appServerGroup
      ? serverAction(appServerGroup, appRow)
      : null;

  // Name the machines when there are several, or when the desktop app's own
  // row sits above the one machine's providers.
  const showMachineLabels = groups.length > 1 || (groups.length === 1 && !serverIsAppRow);

  return (
    <>
      <Popover
        open={popoverOpen}
        onOpenChange={(next, details) => {
          if (next) {
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
              {updateCount > 0 ? (
                <span
                  aria-hidden
                  className="reveal-motion absolute top-2 right-2 size-2 rounded-full bg-info ring-2 ring-nav-rail"
                />
              ) : null}
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
            className="flex flex-col gap-1"
            // Using anything inside a preview pins it, so it stays while the
            // pointer wanders off to watch the update.
            onPointerDownCapture={() => setPinned(true)}
            onKeyDownCapture={(event) => {
              if (event.key === "Enter" || event.key === " ") setPinned(true);
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">Updates</span>
                <span
                  key={summary}
                  className="swap-motion truncate text-xs text-muted-foreground tabular-nums"
                  aria-live="polite"
                >
                  {summary}
                </span>
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={isChecking ? "Checking for updates" : "Check for updates"}
                      aria-busy={isChecking}
                      disabled={isChecking}
                      onClick={() => void checkForUpdates()}
                    >
                      <RefreshIcon refreshing={isChecking} />
                    </Button>
                  }
                />
                <TooltipPopup side="top">
                  {isChecking ? "Checking for updates…" : "Check for updates"}
                </TooltipPopup>
              </Tooltip>
            </div>
            <div className="flex flex-col">
              <UpdateRow row={shownAppRow} updated={updated.has(appRowId)} action={appRowAction} />
              {groups.map((group) => (
                <section key={group.environmentId} className="flex flex-col">
                  {showMachineLabels ? (
                    <span className="mt-1.5 truncate text-xs text-muted-foreground">
                      {group.label}
                    </span>
                  ) : null}
                  {group.server ? (
                    <UpdateRow
                      row={group.server}
                      updated={updated.has(`${group.environmentId}:server`)}
                      action={serverAction(group, group.server)}
                    />
                  ) : null}
                  {group.providers.map((row) => (
                    <UpdateRow
                      key={row.key}
                      row={row}
                      updated={updated.has(`${group.environmentId}:${row.key}`)}
                      action={providerAction(group, row)}
                    />
                  ))}
                </section>
              ))}
              {groups.length === 0 && connected.length === 0 ? (
                <span className="py-1 text-xs text-muted-foreground">
                  No connected machines to check.
                </span>
              ) : null}
            </div>
            {canUpdateAll ? (
              <div className="reveal-motion flex justify-end pt-1">
                <Button size="xs" variant="outline" onClick={updateAll}>
                  Update all
                </Button>
              </div>
            ) : null}
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

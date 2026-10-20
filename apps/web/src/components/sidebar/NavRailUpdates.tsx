/**
 * The rail's Updates button, below Settings. It is always there: quiet at
 * rest, with a dot when this app, a server or a provider CLI (Claude, Codex,
 * Muse Code) on any machine has an update. Its popover lists every component
 * with its version and status, and updates one or all of them through the
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
import { DownloadIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { isElectron } from "~/env";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  canCheckForUpdate,
  getDesktopUpdateDownloadedVersion,
  resolveDesktopUpdateButtonAction,
  shouldShowLocalDesktopUpdateControl,
} from "../desktopUpdate.logic";
import { useServerUpdate } from "../ServerUpdateAction";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  collectProviderUpdateRows,
  describeDesktopUpdateRow,
  describeServerUpdateRow,
  type ProviderUpdateRowView,
  rowNeedsUpdate,
  UPDATE_ROW_STATUS_LABELS,
  type UpdateRowView,
} from "./navRailUpdates.logic";
import { SidebarUpdateCapsule } from "./SidebarUpdateCapsule";
import {
  checkForLocalUpdate,
  confirmAndInstallLocalUpdate,
  downloadLocalUpdate,
  resolveUpdateRunLocalState,
  restartIntoPostponedUpdate,
  runUpdateEverythingPass,
} from "./SidebarUpdatePill";
import { UpdateEverythingDialog } from "./UpdateEverythingDialog";
import { useUpdateEverythingRun } from "./updateEverythingRun";
import { useUpdateEverything } from "./useUpdateEverything";

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

const STATUS_TONE = {
  current: "text-muted-foreground",
  available: "text-foreground",
  updating: "text-muted-foreground",
  failed: "text-destructive",
} as const;

function UpdateRow({ row, action }: { row: UpdateRowView; action?: ReactNode }) {
  const versions = versionLabel(row);
  const status = row.detail ?? UPDATE_ROW_STATUS_LABELS[row.status];
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 py-1">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{row.name}</span>
        <span className="text-xs break-words tabular-nums">
          {versions ? <span className="text-muted-foreground">{versions} · </span> : null}
          <span className={STATUS_TONE[row.status]}>{status}</span>
        </span>
      </div>
      <div className="shrink-0">
        {row.status === "updating" ? <Spinner size="sm" tone="muted" /> : action}
      </div>
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

export function NavRailUpdates({
  buttonClassName,
}: {
  /** The rail's button look, active while the popover is open. */
  buttonClassName: (active: boolean) => string;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
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

  const groups: MachineGroup[] = connected.flatMap((environment, index) => {
    const target = everything.servers.find(
      (server) => server.environmentId === environment.environmentId,
    );
    const server = describeServerUpdateRow({
      currentVersion: environment.serverConfig?.environment.serverVersion ?? null,
      behindVersion: target?.targetVersion ?? null,
      state: serverStates[index] ?? { status: "idle" },
    });
    const providers = collectProviderUpdateRows(environment.serverConfig?.providers ?? []).map(
      (row): ProviderUpdateRowView => {
        const key = `${environment.environmentId}:${row.key}`;
        if (pendingProviders.has(key)) return { ...row, status: "updating", detail: null };
        const error = providerErrors.get(key);
        return error !== undefined ? { ...row, status: "failed", detail: error } : row;
      },
    );
    return server || providers.length > 0
      ? [{ environmentId: environment.environmentId, label: environment.label, server, providers }]
      : [];
  });
  const desktopRow =
    isElectron && desktopState && shouldShowLocalDesktopUpdateControl(desktopState)
      ? describeDesktopUpdateRow(desktopState)
      : null;
  const shownDesktopRow =
    desktopRow && desktopPending && desktopRow.status !== "updating"
      ? { ...desktopRow, status: "updating" as const }
      : desktopRow;

  const updateCount =
    (desktopRow && rowNeedsUpdate(desktopRow) ? 1 : 0) +
    groups.reduce(
      (count, group) =>
        count +
        (group.server && rowNeedsUpdate(group.server) ? 1 : 0) +
        group.providers.filter(rowNeedsUpdate).length,
      0,
    );
  const updateLabel = `${updateCount} ${updateCount === 1 ? "update" : "updates"} available`;
  const tooltip = updateCount > 0 ? `Updates · ${updateLabel}` : "Updates";

  // This app's restart countdown can be postponed, so it stays in view.
  const popoverOpen = open || run?.phase === "countdown";

  const runDesktopAction = (action: "download" | "install" | "check") => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopState || desktopPending) return;
    setDesktopPending(true);
    const pending =
      action === "download"
        ? downloadLocalUpdate(bridge, { notifyDownloaded: true })
        : action === "install"
          ? confirmAndInstallLocalUpdate(bridge, desktopState)
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
    setOpen(false);
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

  const desktopRowAction =
    shownDesktopRow?.action && shownDesktopRow.status !== "updating" ? (
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

  const showMachineLabels = groups.length > 1 || (groups.length === 1 && desktopRow !== null);

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    aria-label={updateCount > 0 ? `Updates, ${updateLabel}` : "Updates"}
                    className={buttonClassName(popoverOpen)}
                  >
                    <DownloadIcon aria-hidden />
                    {updateCount > 0 ? (
                      <span
                        aria-hidden
                        className="absolute top-2 right-2 size-2 rounded-full bg-brand-accent ring-2 ring-nav-rail"
                      />
                    ) : null}
                  </button>
                }
              />
            }
          />
          <TooltipPopup side="right">{tooltip}</TooltipPopup>
        </Tooltip>
        <PopoverPopup side="right" align="end" width="md" padding="compact" aria-label="Updates">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">Updates</span>
                <span className="text-xs text-muted-foreground">
                  {updateCount > 0 ? updateLabel : "Everything is up to date"}
                </span>
              </div>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={checking || desktopState?.status === "checking"}
                onClick={() => void checkForUpdates()}
              >
                {checking || desktopState?.status === "checking"
                  ? "Checking…"
                  : "Check for updates"}
              </Button>
            </div>
            {run !== null ? (
              <div className="flex">
                <SidebarUpdateCapsule
                  run={run}
                  local={resolveUpdateRunLocalState(run, desktopState)}
                  icon={<DownloadIcon aria-hidden className="size-4" />}
                  {...(run.localVersion === null &&
                  desktopAction === "install" &&
                  window.desktopBridge
                    ? {
                        onRestart: () =>
                          restartIntoPostponedUpdate(window.desktopBridge!, localUpdateVersion),
                      }
                    : {})}
                />
              </div>
            ) : null}
            <div className="flex flex-col">
              {shownDesktopRow ? (
                <UpdateRow row={shownDesktopRow} action={desktopRowAction} />
              ) : null}
              {groups.map((group) => (
                <section key={group.environmentId} className="flex flex-col">
                  {showMachineLabels ? (
                    <span className="mt-1 truncate text-xs text-muted-foreground">
                      {group.label}
                    </span>
                  ) : null}
                  {group.server ? (
                    <UpdateRow row={group.server} action={serverAction(group, group.server)} />
                  ) : null}
                  {group.providers.map((row) => (
                    <UpdateRow key={row.key} row={row} action={providerAction(group, row)} />
                  ))}
                </section>
              ))}
              {!shownDesktopRow && groups.length === 0 ? (
                <span className="py-1 text-xs text-muted-foreground">
                  No connected machines to check.
                </span>
              ) : null}
            </div>
            {canUpdateAll ? (
              <div className="flex justify-end">
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
          void runUpdateEverythingPass(everything, desktopAction);
        }}
      />
    </>
  );
}

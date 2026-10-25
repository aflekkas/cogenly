/**
 * The rail's Updates button, below Settings. It is always there: quiet at
 * rest, with a blue dot when this app, a server or a provider CLI (Claude,
 * Codex, Muse Code) on any machine has an update. Hovering or focusing it
 * previews the popover; clicking pins it open.
 *
 * The popover leads with this app: its version and one status line for
 * everything, with the app's update filled unless "Update all" (which takes
 * it too) is offered. What's new sits under it, then one row per component
 * (the Cogenly server, then each provider CLI) across every machine, quiet
 * unless one needs an update. On several machines a row sums up their
 * versions and opens on each machine's own (navRailUpdateGroups.logic.ts),
 * so five servers still make one list. A footer says when it was all last
 * checked and holds "Update all". The release history opens in the same frame.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import type { ServerUpdateState } from "@cogenly/client-runtime/state/server";
import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  type EnvironmentId,
} from "@cogenly/contracts";
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
import { readEnvironmentScope, useEnvironmentsWithScope } from "~/state/session";
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
import { DisclosurePanel, DisclosureTrigger } from "../ui/disclosure";
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
  holdDesktopUpdateStateWhileChecking,
  latestCheckedAt,
  type ProviderUpdateRowView,
  rowNeedsUpdate,
  type UpdatesHeroTone,
  type UpdateRowStatus,
  type UpdateRowView,
} from "./navRailUpdates.logic";
import {
  collectUpdateAllTargets,
  type ComponentUpdateGroup,
  componentUpdateTargets,
  describeComponentFailure,
  describeComponentProgress,
  describeComponentVersions,
  groupUpdatesByComponent,
  type MachineUpdateRow,
  type MachineUpdates,
} from "./navRailUpdateGroups.logic";
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

/** A 2px progress line. The caller positions it: laid over a row's bottom edge, or in flow. */
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
        "reveal-motion pointer-events-none h-0.5 overflow-hidden rounded-full bg-muted",
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

/**
 * A status line's remount key: its text with the numbers taken out, so a new
 * status fades in while a ticking count ("Downloading · 41%") updates in place.
 */
function statusMotionKey(text: string): string {
  return text.replace(/\d+(\.\d+)?/g, "#");
}

function HeroStatus({ tone, label }: { tone: UpdatesHeroTone; label: string }) {
  return (
    // Keyed by state so each new status fades in place instead of snapping.
    <span
      key={`${tone}:${statusMotionKey(label)}`}
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

function isProviderRow(row: UpdateRowView): row is ProviderUpdateRowView {
  return "driver" in row;
}

function RowIcon({ row }: { row: UpdateRowView }) {
  if (isProviderRow(row)) {
    return (
      <ProviderInstanceIcon
        driverKind={row.driver}
        displayName={row.name}
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
 * A row's right edge: a check for a moment once it updated, a spinner while
 * it updates, else its button, else nothing but a faint check on hover.
 */
function RowTrail({
  status,
  justUpdated,
  busyLabel,
  action,
}: {
  status: UpdateRowStatus;
  justUpdated: boolean;
  busyLabel: string;
  action: ReactNode;
}) {
  if (justUpdated) {
    return (
      <span
        key="updated"
        className="swap-motion flex items-center gap-1 text-xs text-success-foreground"
      >
        <CheckIcon aria-hidden className="size-3" strokeWidth={2.5} />
        Updated
      </span>
    );
  }
  if (status === "updating") {
    return (
      <span
        // Keyed without its numbers, so "Updating 2 of 3" ticks in place.
        key={`updating:${statusMotionKey(busyLabel)}`}
        className="swap-motion flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
      >
        <Spinner size="xs" tone="muted" aria-hidden role={undefined} />
        {busyLabel}
      </span>
    );
  }
  if (action) {
    return (
      <span key={`action:${status}`} className="swap-motion flex">
        {action}
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span key="failed" className="swap-motion text-xs text-destructive-foreground">
        Failed
      </span>
    );
  }
  return (
    <CheckIcon
      key="current"
      aria-hidden
      className="size-3 text-muted-foreground opacity-0 transition-opacity duration-(--motion-duration-fast) ease-standard group-hover/row:opacity-55"
      strokeWidth={2.5}
    />
  );
}

const ROW_CLASS_NAME =
  "group/row relative -mx-1.5 flex h-7.5 items-center gap-2 rounded-md px-1.5 transition-colors duration-(--motion-duration-fast) ease-standard hover:bg-accent";

function MachineIcon() {
  return (
    <span
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"
    >
      <LaptopMinimalIcon className="size-3.5" />
    </span>
  );
}

/**
 * One update row: a component on the only machine, or one machine under a
 * component's disclosure. Name and version, nothing else while it is up to
 * date. One that needs an update shows the version it moves to and its
 * button; one updating, a spinner and a progress line.
 */
function ListRow({
  row,
  label,
  leading,
  machine = false,
  note = null,
  updated,
  action,
}: {
  row: UpdateRowView;
  label: string;
  leading: ReactNode;
  /** A machine under a component: a quieter label that truncates. */
  machine?: boolean;
  /** Muted text after the versions, e.g. the one machine a component is on. */
  note?: string | null;
  /** Just finished updating: shows a check for a moment. */
  updated: boolean;
  action: ReactNode;
}) {
  const failure = row.status === "failed" ? row.detail : null;
  return (
    <div className="reveal-motion flex flex-col">
      <div className={cn(ROW_CLASS_NAME, rowNeedsUpdate(row) && "bg-muted/48")}>
        {leading}
        <span
          className={
            machine ? "min-w-0 truncate text-xs text-foreground" : "shrink-0 text-menu font-medium"
          }
        >
          {label}
        </span>
        {note ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">
            <VersionPair current={row.currentVersion} next={row.latestVersion} prefix={false} />
            {` ${note}`}
          </span>
        ) : (
          <VersionPair
            current={row.currentVersion}
            next={row.latestVersion}
            prefix={false}
            className={machine ? "shrink-0" : "min-w-0 truncate"}
          />
        )}
        <span className="flex-1" />
        <span className="flex shrink-0 items-center">
          <RowTrail
            status={row.status}
            justUpdated={updated && row.status === "current"}
            busyLabel={row.detail ?? "Updating"}
            action={action}
          />
        </span>
        {row.status === "updating" ? (
          <ProgressLine
            percent={row.percent ?? null}
            label={`Updating ${label}`}
            className="absolute right-1.5 bottom-0 left-8.5"
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

/**
 * A component on several machines, as one row: its versions across them
 * ("1.4.12 → 1.4.13 on 2 of 5"), one button for every machine that
 * needs it, and "Updating 2 of 3" while they run. The row opens on each
 * machine's own version and button.
 */
function ComponentRow({
  group,
  batch,
  updated,
  action,
  machineAction,
}: {
  group: ComponentUpdateGroup;
  batch: ReadonlySet<string>;
  updated: ReadonlyMap<string, UpdateRowView>;
  action: ReactNode;
  machineAction: (machine: MachineUpdateRow) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const summary = describeComponentVersions(group.machines);
  const progress = describeComponentProgress(group.machines, batch);
  const failure = describeComponentFailure(group.machines);
  const justUpdated =
    group.status === "current" && group.machines.some((machine) => updated.has(machine.id));
  return (
    <div className="reveal-motion flex flex-col">
      <div className={cn(ROW_CLASS_NAME, rowNeedsUpdate(group) && "bg-muted/48")}>
        <DisclosureTrigger
          open={open}
          className="min-w-0 flex-1 self-stretch"
          onClick={() => setOpen((last) => !last)}
        >
          <RowIcon row={group.machines[0]!.row} />
          <span className="shrink-0 text-menu font-medium">{group.name}</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">
            <VersionPair current={summary.current} next={summary.next} prefix={false} />
            {summary.scope && (summary.current || summary.next) ? " " : null}
            {summary.scope}
          </span>
        </DisclosureTrigger>
        <span className="flex shrink-0 items-center">
          <RowTrail
            status={group.status}
            justUpdated={justUpdated}
            busyLabel={progress?.label ?? "Updating"}
            action={action}
          />
        </span>
        {progress ? (
          <ProgressLine
            percent={progress.percent}
            label={`Updating ${group.name}`}
            className="absolute right-1.5 bottom-0 left-8.5"
          />
        ) : null}
      </div>
      {/* Open, each machine row carries its own reason instead. */}
      <DisclosurePanel open={failure !== null && !open}>
        <p className="pt-0.5 pb-1.5 pl-7 text-xs break-words text-muted-foreground">{failure}</p>
      </DisclosurePanel>
      <DisclosurePanel open={open}>
        <div className="flex flex-col pl-7">
          {group.machines.map((machine) => (
            <ListRow
              key={machine.id}
              row={machine.row}
              label={machine.machineLabel}
              leading={<MachineIcon />}
              machine
              updated={updated.has(machine.id)}
              action={machineAction(machine)}
            />
          ))}
        </div>
      </DisclosurePanel>
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

interface TrackedRow {
  readonly id: string;
  readonly row: UpdateRowView;
}

/**
 * Follows rows across renders: which ones have updated since nothing was
 * updating (the batch behind "Updating 2 of 3"), and which just finished, to
 * show their check.
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

  return { batch, updated };
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

  const liveDesktopState = useDesktopUpdateState();
  const desktopChecking = liveDesktopState?.status === "checking";
  // A check holds what the updater last knew, so the popover keeps its shape.
  const [settledDesktopState, setSettledDesktopState] = useState(liveDesktopState);
  if (liveDesktopState && !desktopChecking && liveDesktopState !== settledDesktopState) {
    setSettledDesktopState(liveDesktopState);
  }
  const desktopState = holdDesktopUpdateStateWhileChecking(liveDesktopState, settledDesktopState);
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
  const serverTarget = (environmentId: EnvironmentId) =>
    everything.servers.find((server) => server.environmentId === environmentId);
  // Mirrors the "Update all" pass, which leaves these machines' providers alone.
  const providersManageable = useEnvironmentsWithScope(connected, AuthProvidersManageScope);

  // Each machine's server and provider rows. Every server row is kept, up to
  // date or not, so a component row can say how many machines run what.
  const serverRows = connected.map((environment, index) =>
    describeServerUpdateRow({
      currentVersion: environment.serverConfig?.environment.serverVersion ?? null,
      behindVersion: serverTarget(environment.environmentId)?.targetVersion ?? null,
      state: serverStates[index] ?? { status: "idle" },
      always: true,
    }),
  );
  const firstServerRow = serverRows[0] ?? null;
  const appServerRow =
    serverIsAppRow && firstServerRow ? { ...firstServerRow, name: "Cogenly" } : null;
  const machineUpdates: MachineUpdates[] = connected.map((environment, index) => {
    const target = serverTarget(environment.environmentId);
    const server = serverRows[index] ?? null;
    const isAppRow = serverIsAppRow && index === 0;
    const providers = collectProviderUpdateRows(environment.serverConfig?.providers ?? []).map(
      (row): ProviderUpdateRowView => {
        const key = `${environment.environmentId}:${row.key}`;
        if (pendingProviders.has(key)) return { ...row, status: "updating", detail: null };
        const error = providerErrors.get(key);
        return error !== undefined ? { ...row, status: "failed", detail: error } : row;
      },
    );
    const manageable = providersManageable.has(environment.environmentId);
    return {
      environmentId: environment.environmentId,
      label: environment.label,
      rows: [
        // The browser app's own server is the hero, not a row.
        ...(server && !isAppRow ? [{ row: server, canUpdate: target !== undefined }] : []),
        ...providers.map((row) => ({ row, canUpdate: row.oneClick && manageable })),
      ],
    };
  });
  const shownDesktopRow =
    desktopRow && desktopPending && desktopRow.status !== "updating"
      ? { ...desktopRow, status: "updating" as const }
      : desktopRow;
  // Always a Cogenly row: the desktop updater's; in a browser, the server that
  // serves this app; else this build's version.
  const appServerEnvironmentId = appServerRow ? (connected[0]?.environmentId ?? null) : null;
  const appRow: UpdateRowView =
    shownDesktopRow ?? appServerRow ?? describeAppRow(desktopState?.currentVersion ?? APP_VERSION);
  const appRowId = appServerEnvironmentId ? `${appServerEnvironmentId}:server` : appRow.key;

  const allGroups = groupUpdatesByComponent(machineUpdates);
  const tracked: TrackedRow[] = [
    { id: appRowId, row: appRow },
    ...allGroups.flatMap((group) => group.machines.map(({ id, row }) => ({ id, row }))),
  ];
  const { batch, updated } = useUpdateTransitions(tracked);
  const batchSize = batch.size;
  // Servers show only while one needs attention, or for the check once it updated.
  const groups = allGroups.filter(
    (group) =>
      group.key !== "server" ||
      group.status !== "current" ||
      group.machines.some((machine) => updated.has(machine.id)),
  );

  const updateCount = tracked.filter(({ row }) => rowNeedsUpdate(row)).length;
  const updateLabel = `${updateCount} ${updateCount === 1 ? "update" : "updates"} available`;
  const isChecking = checking || desktopChecking;
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
    if (!bridge || !desktopState || desktopPending || desktopChecking) return;
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
      bridge && canCheckForUpdate(liveDesktopState) ? checkForLocalUpdate(bridge) : null,
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

  // The app's own update counts toward "Update all" when the pass would take it.
  const appServerTarget = appServerEnvironmentId ? serverTarget(appServerEnvironmentId) : undefined;
  const appUpdateTaken =
    rowNeedsUpdate(appRow) &&
    (shownDesktopRow ? desktopAction !== "none" : appServerTarget !== undefined);
  const updateAllCount = collectUpdateAllTargets(groups).length + (appUpdateTaken ? 1 : 0);
  // "Update all" earns its place beside the hero's and the rows' own buttons
  // only when there is more than one update to take.
  const canUpdateAll =
    run === null &&
    updateAllCount > 1 &&
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

  const startUpdate = (machine: MachineUpdateRow) => {
    if (isProviderRow(machine.row)) {
      void runProviderUpdate(machine.environmentId, machine.row);
      return;
    }
    const target = serverTarget(machine.environmentId);
    if (target) void updateServer(target);
  };

  const needsManualInstall = (machine: MachineUpdateRow) =>
    rowNeedsUpdate(machine.row) && isProviderRow(machine.row) && !machine.row.oneClick;

  const machineAction = (machine: MachineUpdateRow) => {
    if (!rowNeedsUpdate(machine.row)) return null;
    if (machine.canUpdate) {
      return (
        <RowButton
          label={machine.row.status === "failed" ? "Retry" : "Update"}
          onClick={() => startUpdate(machine)}
        />
      );
    }
    return needsManualInstall(machine) ? (
      <RowButton label="Settings" onClick={openProviderSettings} />
    ) : null;
  };

  // One button for every machine the component can update on, with one click.
  const componentAction = (group: ComponentUpdateGroup) => {
    const targets = componentUpdateTargets(group);
    if (targets.length > 0) {
      return (
        <RowButton
          label={targets.every((target) => target.row.status === "failed") ? "Retry" : "Update"}
          onClick={() => {
            for (const target of targets) startUpdate(target);
          }}
        />
      );
    }
    return group.machines.some(needsManualInstall) ? (
      <RowButton label="Settings" onClick={openProviderSettings} />
    ) : null;
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
      // Held through a check, the button stays in place but waits for the answer.
      const onClick = desktopChecking ? null : () => runDesktopAction(action);
      if (shownDesktopRow.status === "failed") return { label: "Retry", filled: false, onClick };
      return action === "install"
        ? { label: "Update & restart", filled: true, onClick }
        : { label: "Download", filled: true, onClick };
    }
    if (appServerRow) {
      const row = appServerRow;
      if (row.status === "updating") return { label: "Update", filled: false, onClick: null };
      const target = appServerTarget;
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
      <Button key="all" size="xs" disabled={isChecking} onClick={updateAll}>
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
          // The "Update all" confirmation sits outside this popover, so its
          // clicks and Escape read as outside ones. They belong to the dialog.
          if (confirmingAll) return;
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
                <div className="flex flex-col pt-0.5 pb-2">
                  <div className="flex items-center gap-2.5">
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
                          // "Update all" takes the app's update too, so it is the filled one.
                          variant={heroAction.filled && !canUpdateAll ? "default" : "outline"}
                          disabled={heroAction.onClick === null}
                          onClick={heroAction.onClick ?? undefined}
                        >
                          {heroAction.label}
                        </Button>
                      ) : (
                        <RefreshButton
                          checking={isChecking}
                          onCheck={() => void checkForUpdates()}
                        />
                      )}
                    </div>
                  </div>
                  {/* In flow under the text column, so the hero keeps the same
                    bottom padding as every section while the bar grows in. */}
                  <DisclosurePanel open={appUpdating}>
                    <div className="pt-2 pl-10.5">
                      <ProgressLine
                        percent={restarting ? null : (appRow.percent ?? null)}
                        label={`Updating ${appRow.name}`}
                        className="relative"
                      />
                    </div>
                  </DisclosurePanel>
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
                {groups.length > 0 ? (
                  <section aria-label="Servers and providers" className="flex flex-col pt-2">
                    <div className="flex h-5 items-baseline justify-between gap-2">
                      <span className="text-2xs font-medium text-muted-foreground select-none">
                        Providers
                      </span>
                      <span className="inline-flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
                        <LaptopMinimalIcon aria-hidden className="size-2.75 shrink-0" />
                        <span className="truncate">
                          {connected.length === 1
                            ? connected[0]!.label
                            : `${connected.length} machines`}
                        </span>
                      </span>
                    </div>
                    {groups.map((group) => {
                      const only = group.machines.length === 1 ? group.machines[0]! : null;
                      // On one machine a component is one plain row, as it always was;
                      // beside other machines it names the one it is on.
                      return only ? (
                        <ListRow
                          key={group.key}
                          row={only.row}
                          label={group.name}
                          leading={<RowIcon row={only.row} />}
                          note={connected.length > 1 ? `on ${only.machineLabel}` : null}
                          updated={updated.has(only.id)}
                          action={componentAction(group)}
                        />
                      ) : (
                        <ComponentRow
                          key={group.key}
                          group={group}
                          batch={batch}
                          updated={updated}
                          action={componentAction(group)}
                          machineAction={machineAction}
                        />
                      );
                    })}
                  </section>
                ) : null}
                {connected.length === 0 ? (
                  <span className="pt-2 text-xs text-muted-foreground">
                    No connected machines to check.
                  </span>
                ) : null}
                <div className="mt-2 flex min-h-6 items-center justify-between gap-2 border-t pt-2">
                  <span
                    key={statusMotionKey(footerText)}
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
          // The popover stays open so its rows show the run's progress. Only
          // this app's own restart, at the end of the run, takes it away.
          setConfirmingAll(false);
          void runUpdateEverythingPass(everything, desktopAction);
        }}
      />
    </>
  );
}

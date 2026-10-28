/**
 * The rail's Updates button, below Settings. It is always there: quiet at
 * rest, with a blue dot when this app, a server or a provider CLI (Claude,
 * Codex, Muse Code) on any machine has an update. Hovering or focusing it
 * previews the popover; clicking pins it open.
 *
 * The popover leads with this app: its version and one sentence for the whole
 * state, with the app's update filled unless "Update all" (which takes it too)
 * is offered. What's new sits under it, then one row per component (the
 * Cogenly server, then each provider CLI) across every machine: one version,
 * one status, one progress line. Machines that agree collapse into that row;
 * only when they disagree does it open on each machine's own
 * (navRailUpdateGroups.logic.ts). Offline machines follow. A footer says when
 * it was all last checked and holds refresh and "Update all". The release
 * history opens in the same frame.
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
import { CheckIcon, DownloadIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { APP_VERSION } from "~/branding";
import { isElectron } from "~/env";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import {
  isLocalMachine,
  pairedMachineChoice,
  type RemoteMachine,
} from "~/machines/machineBadge.logic";
import { refreshCogenlyReleases, useCogenlyReleases } from "~/state/cogenlyReleases";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
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
import { MachineChoice } from "../MachineBadge";
import { useServerUpdate } from "../ServerUpdateAction";
import { Button } from "../ui/button";
import { DisclosurePanel, DisclosureTrigger } from "../ui/disclosure";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { RefreshIcon } from "../ui/refresh-icon";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ReleaseHistoryView, type ReleaseTone, WhatsNewNotes } from "./NavRailReleaseNotes";
import {
  collectProviderUpdateRows,
  describeAppRow,
  describeDesktopUpdateRow,
  describeServerUpdateRow,
  describeUpdatesHeroStatus,
  formatCheckedAgo,
  holdDesktopUpdateStateWhileChecking,
  latestCheckedAt,
  type ProviderUpdateRowView,
  rowNeedsUpdate,
  shortenVersionPair,
  type UpdatesHeroTone,
  type UpdateRowStatus,
  type UpdateRowView,
} from "./navRailUpdates.logic";
import {
  collectUpdateAllTargets,
  type ComponentUpdateGroup,
  componentUpdateTargets,
  groupUpdatesByComponent,
  type MachineUpdateRow,
  type MachineUpdates,
  summarizeComponent,
} from "./navRailUpdateGroups.logic";
import {
  type CogenlyRelease,
  compareReleaseVersions,
  releaseHistory,
  releasesBetween,
  whatsNewReleases,
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

/**
 * "v0.1.2 → v0.1.3" with the incoming version in the foreground; `v` for the
 * app only. Build suffixes are dropped and the text truncates before anything
 * beside it does; the full versions stay in its tooltip.
 */
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
  const short = shortenVersionPair(from, to);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn("min-w-0 truncate text-xs text-muted-foreground tabular-nums", className)}
          >
            {format(short.current ?? from)}
            {to ? (
              <>
                <span aria-label=" to " className="mx-0.75 opacity-70">
                  →
                </span>
                <span className="text-foreground">{format(short.next ?? to)}</span>
              </>
            ) : null}
          </span>
        }
      />
      <TooltipPopup side="top">
        {to ? `${format(from)} → ${format(to)}` : format(from)}
      </TooltipPopup>
    </Tooltip>
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
        size="md"
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
 * A row's right edge, its one status: a check for a moment once it updated,
 * "Updating" (or its percent) while the row's line fills, else its button,
 * else nothing but a faint check on hover.
 */
function RowTrail({
  status,
  justUpdated,
  percent,
  action,
}: {
  status: UpdateRowStatus;
  justUpdated: boolean;
  percent: number | null;
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
        // Keyed once, so a ticking percent updates in place.
        key="updating"
        className="swap-motion text-xs whitespace-nowrap text-muted-foreground tabular-nums"
      >
        {percent === null ? "Updating" : `${Math.floor(percent)}%`}
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

/**
 * A machine as a row label, as pickers name it: "This computer" for the
 * primary environment, else its name with a cloud. The name never shrinks:
 * the versions beside it truncate first.
 */
function MachineName({ machine }: { machine: RemoteMachine | null }) {
  return <MachineChoice machine={machine} className="shrink-0 text-xs text-foreground" />;
}

/**
 * The popover's one row: a provider (or server) across every machine, one
 * machine under it, or an offline machine. Leading icon, name, one version,
 * one status at the right edge, and a progress line along the bottom while it
 * updates. `disclosure` makes the row open on `children`, and a failure reads
 * under it while it is closed.
 */
function UpdateRow({
  leading,
  name,
  label,
  current,
  next,
  percent,
  updating,
  highlight,
  failure,
  trail,
  disclosure,
  children,
}: {
  leading: ReactNode;
  /** Plain words for what the row is, for its progress line. */
  name: string;
  label: ReactNode;
  current: string | null;
  next: string | null;
  /** The progress line's fill while `updating`; null runs it indeterminate. */
  percent: number | null;
  updating: boolean;
  /** Tinted while it needs an update. */
  highlight: boolean;
  failure: string | null;
  trail: ReactNode;
  disclosure?: { readonly open: boolean; readonly onToggle: () => void } | null;
  children?: ReactNode;
}) {
  const open = disclosure?.open ?? false;
  const body = (
    <>
      {leading}
      {label}
      <VersionPair current={current} next={next} prefix={false} />
    </>
  );
  return (
    <div className="reveal-motion flex flex-col">
      <div className={cn(ROW_CLASS_NAME, highlight && "bg-muted/48")}>
        {disclosure ? (
          <DisclosureTrigger
            open={open}
            className="min-w-0 flex-1 self-stretch"
            onClick={disclosure.onToggle}
          >
            <span className="flex min-w-0 items-center gap-2">{body}</span>
          </DisclosureTrigger>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-2">{body}</span>
        )}
        <span className="flex shrink-0 items-center">{trail}</span>
        {updating ? (
          <ProgressLine
            percent={percent}
            label={`Updating ${name}`}
            className={cn("absolute right-1.5 bottom-0", leading ? "left-8.5" : "left-1.5")}
          />
        ) : null}
      </div>
      {/* Open, each machine row carries its own reason instead. */}
      <DisclosurePanel open={failure !== null && !open}>
        <p
          className={cn(
            "line-clamp-2 pt-0.5 pb-1.5 text-xs break-words text-muted-foreground",
            leading ? "pl-7" : "pl-0",
          )}
        >
          {failure}
        </p>
      </DisclosurePanel>
      {disclosure ? (
        <DisclosurePanel open={open}>
          <div className="flex flex-col pl-7">{children}</div>
        </DisclosurePanel>
      ) : null}
    </div>
  );
}

/** A row's name: the provider's, or a nested machine's. */
function RowLabel({ children }: { children: ReactNode }) {
  return <span className="shrink-0 text-menu font-medium">{children}</span>;
}

/**
 * A component as one row. Machines that agree collapse into it; only when they
 * disagree (versions, one failed or behind, or the component on some machines
 * only) does it open on each machine's own version and button.
 */
function ComponentRow({
  group,
  batch,
  updated,
  forceSplit,
  machineOf,
  action,
  machineAction,
}: {
  group: ComponentUpdateGroup;
  batch: ReadonlySet<string>;
  updated: ReadonlyMap<string, UpdateRowView>;
  /** The component is missing from some machines, so the list says which. */
  forceSplit: boolean;
  /** A connected machine as a picker shows it: null for this computer. */
  machineOf: (machine: MachineUpdateRow) => RemoteMachine | null;
  action: ReactNode;
  machineAction: (machine: MachineUpdateRow) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const summary = summarizeComponent(group.machines, batch);
  const split = summary.split || forceSplit;
  const justUpdated =
    group.status === "current" && group.machines.some((machine) => updated.has(machine.id));
  return (
    <UpdateRow
      leading={<RowIcon row={group.machines[0]!.row} />}
      name={group.name}
      label={<RowLabel>{group.name}</RowLabel>}
      current={summary.current}
      next={summary.next}
      percent={summary.percent}
      updating={group.status === "updating"}
      highlight={rowNeedsUpdate(group)}
      failure={summary.failure}
      trail={
        <RowTrail
          status={group.status}
          justUpdated={justUpdated}
          percent={summary.percent}
          action={action}
        />
      }
      disclosure={split ? { open, onToggle: () => setOpen((last) => !last) } : null}
    >
      {group.machines.map((machine) => (
        <UpdateRow
          key={machine.id}
          leading={null}
          name={`${group.name} on ${machine.machineLabel}`}
          label={<MachineName machine={machineOf(machine)} />}
          current={machine.row.currentVersion}
          next={machine.row.status === "current" ? null : machine.row.latestVersion}
          percent={machine.row.percent ?? null}
          updating={machine.row.status === "updating"}
          highlight={false}
          failure={machine.row.status === "failed" ? machine.row.detail : null}
          trail={
            <RowTrail
              status={machine.row.status}
              justUpdated={updated.has(machine.id) && machine.row.status === "current"}
              percent={machine.row.percent ?? null}
              action={machineAction(machine)}
            />
          }
        />
      ))}
    </UpdateRow>
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Set when Escape closes the popover and focus goes back to the trigger, so
  // that focus does not preview it again. Cleared once the trigger loses focus.
  const escapedRef = useRef(false);
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
  // Switched on but unreachable: listed so a machine missing from the rows is explained.
  const offline = environments.filter(
    (environment) =>
      environment.entry.enabled &&
      (environment.connection.phase === "offline" ||
        environment.connection.phase === "reconnecting" ||
        environment.connection.phase === "error"),
  );
  // The primary environment is "This computer", in the desktop app and a browser alike.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const machineOf = (machine: MachineUpdateRow) =>
    pairedMachineChoice(
      { environmentId: machine.environmentId, name: machine.machineLabel, online: true },
      primaryEnvironmentId,
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
      // Lowercase, as it is only ever read mid-sentence ("Failed on this computer").
      label: isLocalMachine(environment.environmentId, primaryEnvironmentId)
        ? "this computer"
        : environment.label,
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
  // Loaded once up front too, so a first open already has What's new.
  useEffect(() => refreshCogenlyReleases(), []);
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
  const notesReleases = whatsNewReleases(incomingReleases, installedHistory, installedVersion);
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
    components: allGroups,
    checking: isChecking,
  });
  const footerText = checkedAgo ? `Checked ${checkedAgo}` : "";
  const historyUrl = getDesktopUpdateReleaseHistoryUrl();
  const showReleases = () => {
    setPinned(true);
    setView("releases");
  };
  const appUpdating = appRow.status === "updating" || restarting;
  const hasNotes = notesReleases.length > 0;
  // What's new holds "Earlier releases"; without notes (a dev build, or a list
  // fetched before this release shipped) the footer keeps the way in.
  const showHistoryLink = !hasNotes && (history.length > 0 || historyUrl !== null);
  const footerActions = [
    showHistoryLink ? (
      <Button key="history" size="xs" variant="ghost-muted" onClick={showReleases}>
        Release history
      </Button>
    ) : null,
    countdown ? (
      <Button key="later" size="xs" variant="ghost-muted" onClick={postponeUpdateRestart}>
        Later
      </Button>
    ) : null,
    !anyUpdating && !countdown ? (
      <RefreshButton key="refresh" checking={isChecking} onCheck={() => void checkForUpdates()} />
    ) : null,
    canUpdateAll ? (
      <Button key="all" size="xs" disabled={isChecking} onClick={updateAll}>
        Update all
      </Button>
    ) : null,
  ].filter((action) => action !== null);

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
          if (details.reason === "escape-key") {
            escapedRef.current = true;
            triggerRef.current?.focus();
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
              ref={triggerRef}
              type="button"
              aria-label={updateCount > 0 ? `Updates, ${updateLabel}` : "Updates"}
              className={buttonClassName(pinned || countdown)}
              onClick={() => {
                // A click on an open preview pins it (the popover may not report it).
                if (open && !pinned) setPinned(true);
              }}
              // The release notes load as the pointer heads for the button, so
              // What's new is there when the popover opens instead of arriving after.
              onPointerEnter={() => refreshCogenlyReleases()}
              onFocus={(event) => {
                refreshCogenlyReleases();
                if (escapedRef.current) return;
                // Keyboard focus previews it, as hovering does.
                if (!popoverOpen && event.currentTarget.matches(":focus-visible")) setOpen(true);
              }}
              onBlur={(event) => {
                escapedRef.current = false;
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
                    {heroAction ? (
                      <div
                        key={`action:${heroAction.label}`}
                        className="swap-motion flex shrink-0 items-center"
                      >
                        <Button
                          size="xs"
                          // "Update all" takes the app's update too, so it is the filled one.
                          variant={heroAction.filled && !canUpdateAll ? "default" : "outline"}
                          disabled={heroAction.onClick === null}
                          onClick={heroAction.onClick ?? undefined}
                        >
                          {heroAction.label}
                        </Button>
                      </div>
                    ) : null}
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
                {/* Notes are prefetched before the popover opens; ones that still
                  arrive later grow in rather than pushing the rows down at once. */}
                <DisclosurePanel open={hasNotes}>
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
                </DisclosurePanel>
                {groups.length > 0 || offline.length > 0 || connected.length === 0 ? (
                  <Separator />
                ) : null}
                {groups.length > 0 || offline.length > 0 ? (
                  <section aria-label="Servers and providers" className="flex flex-col pt-2">
                    <span className="flex h-5 items-baseline text-2xs font-medium text-muted-foreground select-none">
                      Providers
                    </span>
                    {groups.map((group) => (
                      <ComponentRow
                        key={group.key}
                        group={group}
                        batch={batch}
                        updated={updated}
                        // A provider on some machines only lists the ones it is on.
                        forceSplit={
                          group.key !== "server" &&
                          connected.length > 1 &&
                          group.machines.length < connected.length
                        }
                        machineOf={machineOf}
                        action={componentAction(group)}
                        machineAction={machineAction}
                      />
                    ))}
                    {offline.map((environment) => {
                      const machine = pairedMachineChoice(
                        {
                          environmentId: environment.environmentId,
                          name: environment.label,
                          online: false,
                        },
                        primaryEnvironmentId,
                      );
                      return (
                        <UpdateRow
                          key={environment.environmentId}
                          leading={null}
                          name={environment.label}
                          label={<MachineName machine={machine} />}
                          current={null}
                          next={null}
                          percent={null}
                          updating={false}
                          highlight={false}
                          failure={null}
                          // A remote machine's label already says "offline" beside its faded cloud.
                          trail={
                            machine === null ? (
                              <span className="text-xs text-muted-foreground">Offline</span>
                            ) : null
                          }
                        />
                      );
                    })}
                  </section>
                ) : null}
                {connected.length === 0 && offline.length === 0 ? (
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

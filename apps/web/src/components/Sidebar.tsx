import {
  type EnvironmentId,
  type ProjectId,
  type ProjectLabelId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { ThreadContextDragGhost } from "./chat/ThreadContextDragGhost";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag as moveThreadContextDragGhost,
} from "./chat/threadContextDrag";
import { discardComposerDraft } from "../lib/discardComposerDraft";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
import { WorkRowStatusMarker } from "./work/WorkRowStatusMarker";
import { useAtomValue } from "@effect/atom-react";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import * as Schema from "effect/Schema";
import {
  canSnooze,
  effectiveSnoozed,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import { createInboxReturnTracker } from "@t3tools/client-runtime/state/thread-inbox";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import {
  planPinnedReorder,
  resolveSettledThreadTimestamp,
  sortActiveThreadsByOrderKey,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import {
  resolveThreadProviderStack,
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentMachineKind,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";

import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  ClockIcon,
  GitBranchIcon,
  MessageCircleQuestionIcon,
  MessageSquareDashedIcon,
  PinIcon,
  SettingsIcon,
  ShieldQuestionIcon,
  FolderPlusIcon,
  SquarePenIcon,
  Undo2Icon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TransitionEvent as ReactTransitionEvent,
} from "react";
import { useParams, useRouter } from "@tanstack/react-router";
import {
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  SidebarSortContext,
  SidebarSortableFoldRow,
  sidebarGroupCollision,
} from "./sidebar/SidebarSortable";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isElectron } from "../env";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useShortcutModifierState } from "../shortcutModifierState";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { isMacPlatform } from "~/lib/utils";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { readLocalApi } from "../localApi";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { selectProjectGroupingSettings } from "../logicalProject";
import {
  getSidebarProjectSettingsKey,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { useUiStateStore } from "../uiStateStore";
import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../threadSelectionStore";
import { useAcknowledgeThreadWoke, useThreadActions } from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSidebarProjectGroups } from "../hooks/useSidebarProjectGroups";
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { registerSettleAndAdvance } from "../settleAndAdvance";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { useClientSettings } from "../hooks/useSettings";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import { useMediaQuery } from "../hooks/useMediaQuery";
import {
  useEnvironmentIdentities,
  useConnectedEnvironmentIds,
  useEnvironmentMachines,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { readThreadShell, useProjects, useThreadShells } from "../state/entities";
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useThreadSearch } from "../state/queries";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { formatRelativeTimeLabel, parseTimestampDate } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import {
  buildDraftActionMenuItems,
  buildRepositoryActionMenuItems,
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
} from "./threadActionMenu.logic";
import {
  filterSidebarV2VisibleThreads,
  buildBulkTitleRegenerationContextMenuItem,
  deleteSelectedThreadEntries,
  formatWorkingDurationLabel,
  firstValidTimestampMs,
  hasUnseenCompletion,
  isSidebarNestedLinkClick,
  isSidebarThreadAwaitingUser,
  isSidebarThreadWorking,
  isTrailingDoubleClick,
  resolveAdjacentThreadId,
  resolveSidebarSweepKeys,
  resolveSidebarThreadSection,
  resolveSidebarRowAccessibility,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  searchSidebarThreads,
  shouldNavigateAfterThreadPark,
  shouldRecedeSidebarThread,
  resolveWorkingStartedAt,
  sidebarThreadKeyAtY,
  sortInboxThreadsByReturn,
  sortThreadsForSidebar,
  sortWorkingThreadsBySend,
  useThreadJumpHintVisibility,
  type SidebarListItem,
  type SidebarSection,
  shouldListWorkDraft,
} from "./Sidebar.logic";
import {
  SidebarDragLifecycle,
  SidebarPointerSensor,
  SidebarSortSensor,
  type SidebarSortSensorOptions,
} from "./Sidebar.pointer";
import { createSidebarListMotion } from "./Sidebar.motion";
import { ThreadWorktreeIndicator } from "./ThreadStatusIndicators";
import { resolveSnoozePresets, snoozeWakeLabel, type SnoozePreset } from "./Sidebar.snooze";
import { ProjectFavicon, type ProjectFaviconProject } from "./ProjectFavicon";
import { ThreadSearchMatchExcerpt } from "./ThreadSearchMatch";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import { ProviderIconStack } from "./chat/ProviderIconStack";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import {
  usageLimitAutoResumeUpdate,
  usageLimitMenuState,
  usageLimitStopForThread,
} from "./chat/usageLimitRecovery.logic";
import { getTriggerDisplayModelLabel } from "./chat/providerIconUtils";
import {
  deriveProviderEntriesByEnvironment,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { useStableCallback } from "../hooks/useStableCallback";
import { showCopiedToast } from "./ui/copiedToast";
import {
  setSidebarContextMenuTarget,
  useSidebarContextMenuTarget,
} from "./sidebar/sidebarContextMenuTarget";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { SidebarContent, SidebarGroup, useSidebar } from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { SidebarSearchDock, type SidebarDockAction } from "./sidebar/SidebarSearchDock";
import { PanOnHoverText } from "./sidebar/PanOnHoverText";
import { PendingTitleSlot } from "./sidebar/PendingTitleSlot";
import { useSidebarRowActionsOverlap } from "./sidebar/useSidebarRowActionsOverlap";
import { SidebarShelfBar, type SidebarShelf } from "./sidebar/SidebarShelfBar";
import { useSegmentSelection } from "./sidebar/sidebarSegments.logic";
import { SIDEBAR_MODE_ICONS } from "./sidebar/modes/SidebarModeSwitcher";
import { RepositoryBadge } from "./sidebar/modes/RepositoryBadge";
import { SidebarRenameField } from "./sidebar/SidebarRenameField";
import {
  projectLabelKey,
  priorFiling,
  scopedRepositoryKey,
  threadFolderState,
  threadForksIntoProjects,
  threadProjectFolderId,
  workThreadFolder,
  type EnvironmentProjectLabel,
  type ProjectLabelKey,
} from "../projectLabels/projectLabels.logic";
import { openCreateProjectDialog } from "../projectLabels/CreateProjectDialogHost";
import { usePendingProjectFolderStore } from "../projectLabels/pendingProjectFolders";
import { useMoveThreadToFolder } from "../projectLabels/useMoveThreadToFolder";
import { useProjectLabelDirectory } from "../projectLabels/useProjectLabels";
import { ProjectFolderIcon } from "../projectLabels/ProjectFolderMark";
import {
  SidebarChatProjectLine,
  useChatProjectMetaAnimates,
} from "./sidebar/SidebarChatProjectLine";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { useNavRailBadgeStore } from "./sidebar/navRailState";
import {
  CHAT_DATE_GROUP_LABELS,
  SidebarAgentsList,
  SidebarModeSwitcher,
  CHAT_LIST_PAGE_SIZE,
  applyPinnedDragOrder,
  chatListGroupOf,
  countChatListGroups,
  createChatDateGrouper,
  orderChatsWithPins,
  pinnedDragOrder,
  useSidebarModeActions,
  useSidebarModeState,
  windowChatList,
} from "./sidebar/modes";
import {
  classifySidebarThreadMode,
  sidebarModeForThread,
  type ChatListGroup,
} from "./sidebar/modes/sidebarModes.logic";
import {
  threadCapabilities,
  threadKindForSidebarMode,
  type ThreadCapabilities,
} from "../threadCapabilities";
import { agentViewKey, requestAgentView } from "../agents/agentViewIntent";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "./ui/menu";
import { SidebarChatStatusSlot } from "./sidebar/SidebarChatStatusSlot";
import {
  SIDEBAR_CARD_CLASS_NAME,
  SIDEBAR_CARD_REST_CLASS_NAME,
  SIDEBAR_DRAFT_CLASS_NAME,
  SIDEBAR_DRAFT_TITLE_CLASS_NAME,
  SidebarCardBody,
  sidebarCardClassName,
  SidebarCardItem,
  SidebarCardLine,
  SidebarFoldRow,
  SidebarGroupHeader,
  SidebarList,
  sidebarRowClassName,
  sidebarRowIntrinsicSizeClassName,
} from "./sidebar/SidebarList";
import { SidebarListEmptyState } from "./sidebar/SidebarListEmptyState";
import {
  applyDrawnOrder,
  groupWorkCards,
  moveInOrder,
  placeInGroupOrder,
  planWorkCardReorder,
  toggleCollapsedSection,
  workCardLabel,
  workGroupSectionKey,
} from "./sidebar/workCards.logic";
import { SidebarListRevealSentinel, useSidebarListReveal } from "./sidebar/SidebarListReveal";
import { useSidebarListAnchor } from "./sidebar/useSidebarListAnchor";
import { sidebarListEdge } from "./sidebar/sidebarListAnchor.logic";
import { useAgentListFilter } from "../agents/agentListFilter";
import { AgentsShelfBar } from "../agents/AgentsShelfBar";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import {
  composerDraftHasUserContent,
  DraftId,
  useComposerDraftStore,
  useThreadHasUnsentDraft,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../composerDraftStore";

const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, ProviderInstanceEntry> = new Map();
/** The folder a row names (chat subtext, Work meta line); null when unfiled. */
interface SidebarRowFolder {
  readonly name: string;
  readonly color: string | undefined;
}
/** An unsent Work draft the list files with the cards. */
interface WorkDraftEntry {
  readonly draftId: DraftId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly createdAtMs: number;
  readonly branch: string | null;
  readonly threadId: ThreadId;
}
/** One card in Work's list: a thread, or a draft (keyed `draft:<id>`). */
type WorkCardEntry =
  | { readonly kind: "thread"; readonly key: string; readonly section: SidebarSection }
  | { readonly kind: "draft"; readonly key: string; readonly draft: WorkDraftEntry };
const EMPTY_SORT_ITEMS: string[] = [];
// Collapsed shelves share one empty list so a route change alone does not
// give the sidebar list a new identity.
const EMPTY_THREADS: readonly EnvironmentThreadShell[] = [];

// Settled-tail paging: recent history is the common lookup, so the deep tail
// loads a page at a time as the list scrolls toward it.
const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;
// Fresh keys deliberately reset both shelves to collapsed for existing users.
const SETTLED_SHELF_EXPANDED_KEY = "cogenly:sidebar:settled-expanded";
const SNOOZED_SHELF_EXPANDED_KEY = "cogenly:sidebar:snoozed-expanded";
const WORKING_SHELF_EXPANDED_KEY = "cogenly:sidebar:working-expanded";
const ATTENTION_FILTER_OPEN_KEY = "cogenly:sidebar:attention-open";
// Section headings the user folded, per space ("chats", "tasks", ...).
const COLLAPSED_SECTIONS_KEY = "cogenly:sidebar:collapsed-sections:v1";
const CollapsedSections = Schema.Record(Schema.String, Schema.Array(Schema.String));
const EMPTY_COLLAPSED_SECTIONS: Readonly<Record<string, readonly string[]>> = {};
const EMPTY_SECTION_KEYS: readonly string[] = [];

// Working beta: when this client saw each thread leave the Working shelf.
// Module scope keeps the inbox order across routes that unmount the sidebar.
const inboxReturns = createInboxReturnTracker();

function canOperateThreads(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  return threads.every((thread) =>
    readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
  );
}

function checkThreadOperations(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  if (canOperateThreads(threads)) return true;
  toastManager.add({
    type: "error",
    title: "Thread action unavailable",
    description: "This connection cannot change one or more selected threads.",
  });
  return false;
}

function compactSidebarTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

function threadTimeLabel(thread: SidebarThreadSummary): string {
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt;
  return compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp));
}

// Settled rows read "how long ago did this wrap up", matching their sort
// key: both go through resolveSettledThreadTimestamp so label and order can't
// disagree.
function settledTimeLabel(thread: SidebarThreadSummary): string {
  const timestamp = resolveSettledThreadTimestamp(thread);
  return timestamp === null ? "" : compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp));
}

// Floats at the row's right edge, vertically centered, while the jump
// modifier is held. An overlay pill instead of an inline slot: the hint
// must neither displace the status/time label (holding ⌘ used to blank
// out "Working") nor shift any layout when it appears. pointer-events-none
// so it never swallows clicks meant for the settle/un-settle buttons it
// can overlap.
function JumpHintBadge(props: { label: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1.5 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-3xs font-medium tracking-tight text-foreground shadow-sm"
    >
      {props.label}
    </span>
  );
}

// Self-ticking so only this span re-renders each second, not the whole row.
function WorkingDuration(props: { startedAt: string | null }) {
  const startedMs = props.startedAt !== null ? Date.parse(props.startedAt) : Number.NaN;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (Number.isNaN(startedMs)) return;
    const id = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(id);
  }, [startedMs]);
  if (Number.isNaN(startedMs)) return null;
  return <span className="tabular-nums">{formatWorkingDurationLabel(Date.now() - startedMs)}</span>;
}

// The stack's chips take the card's fill so the overlap reads as a cut: the
// resting card (no fill in light themes, so the column), the hover fill, or the
// selected fill, which wins over hover.
function SidebarProviderStack(props: {
  thread: SidebarThreadSummary;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  selected: boolean;
}) {
  const stack = resolveThreadProviderStack(props.thread);
  const currentInstanceId = stack[stack.length - 1]!;
  const currentEntry = props.providerEntryByInstanceId.get(currentInstanceId) ?? null;
  if (currentEntry === null) return null;
  const showInstanceBadge = shouldShowInstanceBadge(
    currentEntry,
    props.providerEntryByInstanceId.values(),
  );
  const current = (
    <ProviderInstanceIcon
      driverKind={currentEntry.driverKind}
      displayName={currentEntry.displayName}
      accentColor={currentEntry.accentColor}
      showBadge={showInstanceBadge}
      // Glyph dims, the instance dot stays saturated.
      iconClassName="size-3.5 opacity-60"
      indicatorBackground="var(--provider-stack-ring)"
    />
  );
  const ringClassName = props.selected
    ? "[--provider-stack-ring:var(--state-selected-fill)]"
    : "[--provider-stack-ring:var(--sidebar-card,var(--sidebar))] group-any-hover/sidebar-row:[--provider-stack-ring:var(--state-hover-fill)]";
  if (stack.length === 1) {
    return (
      <span className={cn("inline-flex shrink-0 items-center", ringClassName)}>{current}</span>
    );
  }
  const earlier = stack.slice(0, -1).flatMap((instanceId) => {
    const entry = props.providerEntryByInstanceId.get(instanceId);
    if (entry === undefined) return [];
    return [
      {
        key: instanceId,
        icon: (
          <ProviderInstanceIcon
            driverKind={entry.driverKind}
            displayName={entry.displayName}
            iconClassName="size-3 opacity-35 grayscale"
          />
        ),
      },
    ];
  });
  // Oldest first, the current provider last and on top.
  return (
    <ProviderIconStack
      className={ringClassName}
      items={[...earlier, { key: currentInstanceId, icon: current }]}
    />
  );
}

/**
 * Hover entry point for snooze: a clock button opening the preset menu.
 * Controlled by the row (which also uses the open state to pin its hover
 * actions while the menu is up).
 */
function SnoozeMenuButton(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  timestampFormat: TimestampFormat;
}) {
  const { open, onOpenChange, onSnooze, timestampFormat } = props;
  // Presets resolve at open time so "In 1 hour" is relative to the click,
  // not to when the row mounted.
  const presets = useMemo(
    () => (open ? resolveSnoozePresets(new Date(), timestampFormat) : []),
    [open, timestampFormat],
  );
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Snooze thread"
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className="inline-flex h-full cursor-pointer items-center gap-0.5 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                />
              }
            />
          }
        >
          <ClockIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>Snooze thread</TooltipPopup>
      </Tooltip>
      <MenuPopup side="bottom" align="end">
        {presets.map((preset) => (
          <MenuItem
            key={preset.id}
            onClick={(event) => {
              event.stopPropagation();
              onSnooze(preset);
            }}
          >
            {preset.label}
            <MenuShortcut>{preset.whenLabel}</MenuShortcut>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          onClick={async (event) => {
            event.stopPropagation();
            const choice = await requestCustomSnooze();
            if (choice) onSnooze(choice);
          }}
        >
          Custom…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

// Unsent work is marked by a pen, on draft cards and on thread rows with
// unsent composer text alike, on the amber draft surface and title
// (SIDEBAR_DRAFT_CLASS_NAME). The warning tone, like Approval.
const draftPenClassName = "size-3 shrink-0 text-warning-foreground";

// Work's count bar, in order: all tasks, then each filter.
const WORK_SHELF_ORDER: ReadonlyArray<SidebarShelf | null> = [
  null,
  "attention",
  "snoozed",
  "settled",
];

// Pointer travel before a press on a row starts a context drag, or a press on
// its action button starts a sweep. Shorter presses stay clicks.
const SIDEBAR_DRAG_DISTANCE = 6;

type SidebarSweepAction = "settle" | "unsettle" | "unsnooze";

/**
 * A Work card's first line, after T3's card (SidebarThreadRow.tsx upstream):
 * the repository's icon and name, led by its project ("Spawn Partners ·
 * platform"); the project's folder for repository-less Work in a project; a
 * dashed mark and "No project" for Work in neither. Hover actions layered over
 * the status slot fade its end out (useSidebarRowActionsOverlap measures this
 * line's text, the row's first `.pan-text`).
 */
function WorkCardLabel(props: {
  readonly folder: SidebarRowFolder | null;
  readonly repositoryName: string | null;
  readonly project: ProjectFaviconProject | null;
  /** The card sits under its project's heading, so the line names the repository alone. */
  readonly projectInHeading?: boolean | undefined;
  /** Right-click on the line opens its repository's menu, not the thread's. */
  readonly onContextMenu?: ((event: ReactMouseEvent) => void) | undefined;
}) {
  const label = workCardLabel({
    projectName: props.folder?.name ?? null,
    repositoryName: props.repositoryName,
    projectInHeading: props.projectInHeading === true,
  });
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5" onContextMenu={props.onContextMenu}>
      {props.repositoryName && props.project ? (
        <ProjectFavicon
          project={props.project}
          className="size-4 shrink-0"
          fallback={<RepositoryBadge name={props.repositoryName} />}
        />
      ) : props.folder ? (
        <ProjectFolderIcon color={props.folder.color} className="size-4" />
      ) : (
        // The same mark as "No project" in the pickers and palette.
        <MessageSquareDashedIcon aria-hidden className="size-4 shrink-0 text-secondary-label" />
      )}
      <PanOnHoverText className="min-w-0 flex-1 text-xs font-medium text-secondary-label">
        {label}
      </PanOnHoverText>
    </span>
  );
}

function SidebarSectionHeader(props: {
  marker: "working-header" | "snoozed-header" | "settled-header";
  label: string;
  count: number;
  toggle: { expanded: boolean; onToggle: () => void };
}) {
  const shelf =
    props.marker === "working-header"
      ? "working"
      : props.marker === "snoozed-header"
        ? "snoozed"
        : "settled";
  return (
    <SidebarGroupHeader
      data-thread-selection-safe
      data-testid={`sidebar-${props.marker}`}
      label={props.label}
      count={props.count}
      tone={shelf === "snoozed" ? "info" : "muted"}
      collapse={{
        open: props.toggle.expanded,
        onToggle: props.toggle.onToggle,
        testId: `sidebar-${shelf}-shelf-toggle`,
      }}
    />
  );
}

/**
 * What the Chats and Work list sits in: its tooltips' timing, and the dnd-kit
 * context Work's cards sort in (SidebarSortContext).
 */
function SidebarThreadListProviders(props: ComponentProps<typeof SidebarSortContext>) {
  return (
    <TooltipProvider delay={150} closeDelay={0} timeout={400}>
      <SidebarSortContext {...props} />
    </TooltipProvider>
  );
}

// One unsent draft session the user has invested content in. Two lines,
// nothing else: project name, then the typed prompt. All the draft's
// settings (model, env mode, branch, worktree) still travel with it —
// clicking is a plain navigation to /draft/$draftId, which touches nothing.
// While the draft is open the row renders a frozen snapshot (see
// SidebarDraftBlock); memoized so per-keystroke block re-renders skip it
// entirely.
const SidebarDraftRow = memo(function SidebarDraftRow(props: {
  draftId: DraftId;
  composer: ComposerThreadDraftState;
  branch?: string | null;
  /** The Work draft's project, named ahead of its branch like a Work card's. */
  folder?: SidebarRowFolder | null;
  /** Work grouped by project names the repository instead; null for none. */
  repositoryName?: string | null;
  /** Under its project's heading the card names the repository alone. */
  projectInHeading?: boolean | undefined;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  isActive: boolean;
  /** Chats rows are text only: the draft's first line and a muted "Draft". */
  slim: boolean;
  onNavigate: (draftId: DraftId) => void;
  onDiscard: (draftId: DraftId) => void;
  onContextMenu: (draftId: DraftId, position: { x: number; y: number }) => void;
}) {
  const { composer, draftId, onContextMenu, onDiscard, onNavigate } = props;
  const promptPreview =
    replaceComposerContextReferences(composer.prompt, (occurrence) => occurrence.label)
      .trim()
      .split("\n", 1)[0] ?? "";
  // images mirrors persistedAttachments once rehydration finishes; before
  // that only the persisted list is populated, hence max not sum.
  const attachmentCount =
    Math.max(composer.images.length, composer.persistedAttachments.length) +
    composer.files.length +
    composer.terminalContexts.length +
    composer.previewAnnotations.length +
    composer.reviewComments.length;
  const preview =
    promptPreview.length > 0
      ? promptPreview
      : `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`;
  const accessibility = resolveSidebarRowAccessibility({
    title: preview,
    statusLabel: "Unsent draft",
    projectDisplayName: props.projectDisplayName,
    isActive: props.isActive,
  });
  const handleActivate = useCallback(() => onNavigate(draftId), [draftId, onNavigate]);
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      // Keys targeting the nested discard button belong to the button:
      // preventDefault here would swallow Space's synthesized click and
      // navigate instead of discarding.
      if ((event.target as HTMLElement).closest("button")) return;
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        onContextMenu(draftId, { x: rect.left, y: rect.bottom });
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onNavigate(draftId);
      }
    },
    [draftId, onContextMenu, onNavigate],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(draftId, { x: event.clientX, y: event.clientY });
    },
    [draftId, onContextMenu],
  );
  const handleDiscard = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onDiscard(draftId);
    },
    [draftId, onDiscard],
  );
  const discardButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Discard draft"
            onClick={handleDiscard}
            className="pointer-events-none inline-flex cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100"
          >
            <XIcon className="size-3" />
          </button>
        }
      />
      <TooltipPopup side="top">Discard draft</TooltipPopup>
    </Tooltip>
  );
  if (props.slim) {
    return (
      <li className="list-none">
        <div
          role="button"
          tabIndex={0}
          aria-label={accessibility.label}
          aria-current={accessibility.current}
          data-testid="sidebar-draft-row"
          className={sidebarRowClassName({ selected: props.isActive, draft: true })}
          onClick={handleActivate}
          onContextMenu={handleContextMenu}
          onKeyDown={handleKeyDown}
        >
          <span className={cn("min-w-0 flex-1 truncate text-sm", SIDEBAR_DRAFT_TITLE_CLASS_NAME)}>
            {preview}
          </span>
          <span className="relative flex h-5 shrink-0 items-center justify-end">
            <span
              aria-hidden
              className="text-2xs text-warning-foreground transition-opacity group-focus-within/sidebar-row:opacity-0 group-hover/sidebar-row:opacity-0"
            >
              Draft
            </span>
            <span className="absolute inset-y-0 right-0 flex items-center">{discardButton}</span>
          </span>
        </div>
      </li>
    );
  }
  // A Work card like any other, marked as a draft in the status slot.
  return (
    <SidebarCardItem>
      <div
        role="button"
        tabIndex={0}
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        data-testid="sidebar-draft-row"
        className={sidebarCardClassName({ selected: props.isActive, draft: true })}
        onClick={handleActivate}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
      >
        <span className="sr-only">{preview}</span>
        <SidebarCardBody>
          <SidebarCardLine line="head">
            <WorkCardLabel
              folder={props.folder ?? null}
              repositoryName={props.repositoryName ?? null}
              project={props.project}
              projectInHeading={props.projectInHeading}
            />
            <span className="relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs">
              <span
                aria-hidden
                className="pointer-events-none flex items-center gap-1 self-center font-medium text-warning-foreground transition-opacity duration-(--motion-duration-base) ease-standard motion-reduce:transition-none group-has-[:focus-visible]/sidebar-row:opacity-0 group-any-hover/sidebar-row:opacity-0"
              >
                <SquarePenIcon className={draftPenClassName} />
                Draft
              </span>
              <span className="absolute inset-y-0 right-0 flex items-center">{discardButton}</span>
            </span>
          </SidebarCardLine>
          <SidebarCardLine line="title">
            <span
              aria-hidden
              className={cn(
                "min-w-0 flex-1 truncate text-sm font-medium",
                SIDEBAR_DRAFT_TITLE_CLASS_NAME,
              )}
            >
              {preview}
            </span>
          </SidebarCardLine>
          <SidebarCardLine line="meta" tone="faint">
            {props.branch ? (
              <>
                <GitBranchIcon aria-hidden className="size-3 shrink-0" />
                <span className="min-w-0 flex-1 fade-truncate">{props.branch}</span>
              </>
            ) : null}
          </SidebarCardLine>
        </SidebarCardBody>
      </div>
    </SidebarCardItem>
  );
});

/**
 * One Work draft, listed after the cards of its project's group. Reads its
 * own composer, so typing in another draft repaints nothing here. The open
 * draft's card is frozen at the moment it became the route, and a draft never
 * left has no card at all, as in SidebarDraftBlock.
 */
const SidebarWorkDraftCard = memo(function SidebarWorkDraftCard(props: {
  draftId: DraftId;
  branch: string | null;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  /** Its repository, named on the card's first line; null without one. */
  repositoryName: string | null;
  /** The project the draft's repository is in, which the draft follows. */
  repositoryFolder: SidebarRowFolder | null;
  folderForLabel: (
    environmentId: EnvironmentId,
    labelId: ProjectLabelId,
  ) => SidebarRowFolder | null;
  /** The card sits under its project's heading. */
  projectInHeading: boolean;
  isActive: boolean;
  onNavigate: (draftId: DraftId) => void;
  onContextMenu: (draftId: DraftId, position: { x: number; y: number }) => void;
}) {
  const withContent = (composer: ComposerThreadDraftState | undefined) =>
    composer && composerDraftHasUserContent(composer) ? composer : null;
  const [frozen, setFrozen] = useState(() => ({
    isActive: props.isActive,
    composer: props.isActive
      ? withContent(useComposerDraftStore.getState().draftsByThreadKey[props.draftId])
      : null,
  }));
  if (frozen.isActive !== props.isActive) {
    setFrozen({
      isActive: props.isActive,
      composer: props.isActive
        ? withContent(useComposerDraftStore.getState().draftsByThreadKey[props.draftId])
        : null,
    });
  }
  const liveComposer = useComposerDraftStore((store) =>
    props.isActive ? undefined : store.draftsByThreadKey[props.draftId],
  );
  const composer = props.isActive ? frozen.composer : withContent(liveComposer);
  // A project picked in the Work hero rides on the draft until its first send.
  const pickedFolderId = usePendingProjectFolderStore((state) => {
    const entry = state.byThreadId[props.threadId];
    return entry?.environmentId === props.environmentId ? entry.folderId : null;
  });
  const folder =
    (pickedFolderId === null ? null : props.folderForLabel(props.environmentId, pickedFolderId)) ??
    props.repositoryFolder;
  if (!composer) return null;
  return (
    <SidebarDraftRow
      draftId={props.draftId}
      composer={composer}
      branch={props.branch}
      folder={folder}
      repositoryName={props.repositoryName}
      projectInHeading={props.projectInHeading}
      project={props.project}
      projectDisplayName={props.projectDisplayName}
      isActive={props.isActive}
      slim={false}
      onNavigate={props.onNavigate}
      // The /draft/$draftId route redirects home on its own when the draft it
      // renders disappears, so discarding the open draft needs nothing more.
      onDiscard={discardComposerDraft}
      onContextMenu={props.onContextMenu}
    />
  );
});

interface SidebarDraftRowData {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState;
}

// Draft sessions with user content, surfaced above the thread list so an
// interrupted "new thread" stays one click away. Self-contained (own store
// subscription + closing divider) so per-keystroke composer updates
// re-render only this block, never the whole sidebar. Vanishes at count 0.
const SidebarDraftBlock = memo(function SidebarDraftBlock(props: {
  projectByKey: ReadonlyMap<string, EnvironmentProject>;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  draftInMode: (draft: DraftSessionState) => boolean;
  routeDraftId: string | null;
  slim: boolean;
  onNavigateToDraft: (draftId: DraftId) => void;
  onDraftContextMenu: (draftId: DraftId, position: { x: number; y: number }) => void;
}) {
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftsByThreadKey = useComposerDraftStore((store) => store.draftsByThreadKey);
  // The open draft's row is FROZEN at the moment the draft became the route:
  // it stays visible (like a thread row) but never repaints while the user
  // types. A draft that was never navigated away from has no snapshot to
  // freeze, so a fresh typing session shows no row at all. Captured
  // synchronously on route change (setState-during-render derived state) so
  // the row never flickers out for a frame between route change and capture.
  const [frozenActive, setFrozenActive] = useState<{
    routeDraftId: string | null;
    row: SidebarDraftRowData | null;
  }>({ routeDraftId: null, row: null });
  if (frozenActive.routeDraftId !== props.routeDraftId) {
    let row: SidebarDraftRowData | null = null;
    if (props.routeDraftId !== null) {
      const draftId = DraftId.make(props.routeDraftId);
      const store = useComposerDraftStore.getState();
      const session = store.getDraftSession(draftId);
      const composer = store.getComposerDraft(draftId);
      row =
        session && session.promotedTo == null && composer && composerDraftHasUserContent(composer)
          ? { draftId, session, composer }
          : null;
    }
    setFrozenActive({ routeDraftId: props.routeDraftId, row });
  }
  const drafts = useMemo(() => {
    const rows: SidebarDraftRowData[] = [];
    // Every non-promoted session with content gets a row, mapped or not:
    // new-thread surfaces mint fresh drafts and leave invested ones behind
    // unmapped, so the mapping only knows about the latest per project.
    for (const [draftKey, session] of Object.entries(draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      if (!props.draftInMode(session)) {
        continue;
      }
      if (draftKey === props.routeDraftId) {
        // Open draft: render the frozen entry snapshot, or nothing for a
        // draft that has never been left. Gated on the LIVE session above so
        // send/discard still removes the row immediately.
        if (frozenActive.routeDraftId === draftKey && frozenActive.row !== null) {
          rows.push(frozenActive.row);
        }
        continue;
      }
      const composer = draftsByThreadKey[draftKey];
      if (!composer || !composerDraftHasUserContent(composer)) {
        continue;
      }
      rows.push({ draftId: DraftId.make(draftKey), session, composer });
    }
    rows.sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt));
    return rows;
  }, [
    draftThreadsByThreadKey,
    draftsByThreadKey,
    frozenActive,
    props.routeDraftId,
    props.draftInMode,
  ]);
  if (drafts.length === 0) {
    return null;
  }
  return (
    <>
      {drafts.map(({ composer, draftId, session }) => {
        const projectKey = `${session.environmentId}:${session.projectId}`;
        return (
          <SidebarDraftRow
            key={draftId}
            draftId={draftId}
            composer={composer}
            project={props.projectByKey.get(projectKey) ?? null}
            projectDisplayName={props.projectDisplayNameByKey.get(projectKey) ?? null}
            isActive={draftId === props.routeDraftId}
            slim={props.slim}
            onNavigate={props.onNavigateToDraft}
            // The /draft/$draftId route redirects home on its own when the
            // draft it renders disappears, so discarding the open draft needs
            // no special-casing here.
            onDiscard={discardComposerDraft}
            onContextMenu={props.onDraftContextMenu}
          />
        );
      })}
      <li
        aria-hidden
        data-testid="sidebar-draft-divider"
        className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
      />
    </>
  );
});

// Verb and icon on rows an action sweep will touch. Uses the same icons as
// the row actions and context menu so the sweep reads as the action it applies.
const sweepActionBadge: Record<SidebarSweepAction, ReactNode> = {
  settle: (
    <>
      <CircleCheckIcon aria-hidden className="size-3" />
      Settle
    </>
  ),
  unsettle: (
    <>
      <Undo2Icon aria-hidden className="size-3" />
      Un-settle
    </>
  ),
  unsnooze: (
    <>
      <AlarmClockOffIcon aria-hidden className="size-3" />
      Wake
    </>
  ),
};

/**
 * A Chats row: the title, and under it the chat's project when it is in one,
 * with a status slot at its end. A running
 * turn shows a small spinner, a reply you have not seen shows a blue dot, a
 * chat waiting on you an amber one; an unread reply also makes the title
 * heavier. A pinned chat carries a small muted pin before its title.
 * Everything else (rename, pin, archive, Start Work) lives in the context menu.
 */
const SidebarChatRow = memo(function SidebarChatRow(props: {
  thread: SidebarThreadSummary;
  // The project named on the row's second line; null keeps it one line.
  folder: SidebarRowFolder | null;
  // False until the project list has painted, so only a move animates the row.
  animateFolder: boolean;
  isActive: boolean;
  jumpLabel: string | null;
  /** Compact last-activity time ("20m"), recomputed on the sidebar's minute tick. */
  timeLabel: string;
  isRenaming: boolean;
  renamingTitle: string;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  /** Offered in the rename field while renaming, when the server can name the thread. */
  onRegenerateTitle?: ((threadRef: ScopedThreadRef) => void) | undefined;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onContextDragStart: (threadRef: ScopedThreadRef, event: PointerEvent) => void;
}) {
  const {
    isRenaming,
    onCancelRename,
    onCommitRename,
    onContextDragStart,
    onContextMenu,
    onRenameTitleChange,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    renamingTitle,
    thread,
  } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const threadKey = scopedThreadKey(threadRef);
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  useEffect(() => {
    if (!canOperateThread && isRenaming) onCancelRename();
  }, [canOperateThread, isRenaming, onCancelRename]);
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const isContextMenuOpen = useSidebarContextMenuTarget((state) => state.threadKey === threadKey);
  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarThreadStatus(thread);
  const needsYou = status === "approval" || status === "input";
  const isRunning = status === "working" || status === "waiting";
  const statusLabel =
    status === "working"
      ? "Working"
      : status === "waiting"
        ? "Waiting"
        : status === "approval"
          ? "Needs approval"
          : status === "input"
            ? "Needs input"
            : isUnread
              ? "Unread"
              : thread.pinnedAt != null
                ? "Pinned"
                : null;
  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel,
    projectDisplayName: props.folder ? `in ${props.folder.name}` : null,
    isActive: props.isActive,
  });

  const handleClick = useCallback(
    (event: ReactMouseEvent) => onThreadClick(event, threadRef),
    [onThreadClick, threadRef],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu, threadRef],
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onThreadActivate(threadRef);
    },
    [onThreadActivate, threadRef],
  );
  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (
        !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) ||
        isRenaming ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      if ((event.target as HTMLElement).closest("button, a, input")) return;
      event.preventDefault();
      onStartRename(threadRef, thread.title);
    },
    [isRenaming, onStartRename, thread.title, threadRef],
  );
  const handleRowPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (isRenaming || !event.isPrimary || event.button !== 0) return;
      onContextDragStart(threadRef, event.nativeEvent);
    },
    [isRenaming, onContextDragStart, threadRef],
  );
  const renameCommittedRef = useRef(false);
  useEffect(() => {
    if (isRenaming) renameCommittedRef.current = false;
  }, [isRenaming]);
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCommitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCancelRename();
      }
    },
    [onCancelRename, onCommitRename, renamingTitle, thread.title, threadRef],
  );
  const handleRenameBlur = useCallback(() => {
    if (!renameCommittedRef.current) onCommitRename(threadRef, renamingTitle, thread.title);
  }, [onCommitRename, renamingTitle, thread.title, threadRef]);
  const { onRegenerateTitle } = props;
  const handleRegenerateTitle = useMemo(
    () =>
      onRegenerateTitle &&
      (() => {
        renameCommittedRef.current = true;
        onRegenerateTitle(threadRef);
      }),
    [onRegenerateTitle, threadRef],
  );

  return (
    <li
      data-thread-item={threadKey}
      onPointerDown={handleRowPointerDown}
      // Matches the row's height (h-8, or h-10 with a project line) so
      // unrendered rows never shift the list when they paint.
      className={cn(
        "list-none [content-visibility:auto]",
        sidebarRowIntrinsicSizeClassName(props.folder ? 2 : 1),
      )}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        data-testid="sidebar-row-chat"
        aria-busy={thread.titleRegeneration != null || undefined}
        className={sidebarRowClassName({
          selected: props.isActive || isSelected || isContextMenuOpen,
          lines: props.folder ? 2 : 1,
          className: cn(
            props.animateFolder &&
              "transition-[height] duration-(--motion-duration-base) ease-standard motion-reduce:transition-none",
            isContextMenuOpen && "focus-visible:ring-0",
          ),
        })}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
      >
        {/* The pin's slot opens from nothing, so pinning eases the title over
            instead of jumping it. Its negative margin cancels the row gap
            while empty; open, the pin sits 4px before the title. */}
        <span
          aria-hidden
          className={cn(
            "-mr-2 flex shrink-0 items-center overflow-hidden transition-[width,opacity] duration-(--motion-duration-base) ease-standard motion-reduce:transition-opacity",
            thread.pinnedAt != null ? "w-4 opacity-100" : "w-0 opacity-0",
          )}
        >
          <PinIcon className="size-3 shrink-0 text-sidebar-muted-foreground/60" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          {isRenaming && canOperateThread ? (
            <SidebarRenameField
              value={renamingTitle}
              ariaLabel="Chat title"
              onChange={onRenameTitleChange}
              onKeyDown={handleRenameKeyDown}
              onBlur={handleRenameBlur}
              onRegenerate={handleRegenerateTitle}
              inputClassName="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm text-card-foreground outline-none focus:border-foreground"
            />
          ) : (
            <PendingTitleSlot
              pending={thread.titleRegeneration != null}
              className="min-w-0 text-sm"
            >
              <PanOnHoverText
                className={cn(
                  isUnread || needsYou ? "font-medium text-foreground" : "font-normal",
                  props.isActive
                    ? "text-foreground"
                    : !(isUnread || needsYou) && "text-foreground/80",
                )}
              >
                <span aria-hidden>{thread.title}</span>
              </PanOnHoverText>
            </PendingTitleSlot>
          )}
          <SidebarChatProjectLine project={props.folder} animate={props.animateFolder} />
        </span>
        {/* With a project line, the time stays on the title line. */}
        <span className={cn("flex shrink-0", props.folder && "mt-1 self-start")}>
          <SidebarChatStatusSlot
            isRunning={isRunning}
            dot={needsYou ? "warning" : isUnread ? "info" : null}
            timeLabel={props.timeLabel}
          />
        </span>
        {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
      </div>
    </li>
  );
});

const SidebarThreadRow = memo(function SidebarThreadRow(props: {
  thread: SidebarThreadSummary;
  variant: "card" | "slim";
  // Settled rows un-settle, snoozed rows wake, and cards settle.
  variantAction: SidebarSweepAction;
  // False on environments whose server predates thread.settle/unsettle:
  // the lifecycle affordances hide entirely rather than fail on click.
  settlementSupported: boolean;
  // Same contract for thread.snooze/unsnooze.
  snoozeSupported: boolean;
  // The repository named on the card's first line; null for scratch work.
  repositoryName: string | null;
  // Opens the repository's menu (new thread, its project, settings).
  onRepositoryContextMenu?: (
    projectRef: ScopedProjectRef,
    position: { x: number; y: number },
  ) => void;
  // The folder the row is filed in, leading its meta line.
  folder: SidebarRowFolder | null;
  // Under its project's heading the card names its repository alone.
  projectInHeading?: boolean | undefined;
  // The action this row will take when the sweep is released.
  sweepAction: SidebarSweepAction | null;
  // Compact wake countdown ("2h") for rows in the snoozed shelf.
  snoozeWakeLabelText: string | null;
  // When a snooze ended (timer or early wake); drives the Woke pill until
  // the user visits the thread.
  wokeAt: string | null;
  isActive: boolean;
  jumpLabel: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  // The agent that started this work thread; null for the user's own threads.
  workAgentName: string | null;
  // Work rows add how their last run ended (paused, canceled) to the meta line.
  showWorkStatus: boolean;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  timestampFormat: TimestampFormat;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  /** Offered in the rename field while renaming, when the server can name the thread. */
  onRegenerateTitle?: ((threadRef: ScopedThreadRef) => void) | undefined;
  isRenaming: boolean;
  renamingTitle: string;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onSettle: (threadRef: ScopedThreadRef) => void;
  onActionSweepStart: (
    threadRef: ScopedThreadRef,
    action: SidebarSweepAction,
    event: PointerEvent,
  ) => void;
  onUnsettle: (threadRef: ScopedThreadRef) => void;
  onSnooze: (threadRef: ScopedThreadRef, preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  onUnsnooze: (threadRef: ScopedThreadRef) => void;
  // Pressing the row and dragging it out of the list drops the thread into a
  // composer as context. Sortable Work cards leave this to their slot.
  onContextDragStart: (threadRef: ScopedThreadRef, event: PointerEvent) => void;
  onAcknowledgeWoke: (threadRef: ScopedThreadRef, visitedAt: string) => void;
  onFileDropThreads?: ((threadRef: ScopedThreadRef, files: File[]) => void) | undefined;
}) {
  const {
    isRenaming,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onAcknowledgeWoke,
    onFileDropThreads,
    onRenameTitleChange,
    onSettle,
    onActionSweepStart,
    onSnooze,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    onUnsettle,
    onUnsnooze,
    onContextDragStart,
    renamingTitle,
    thread,
    variant,
    variantAction,
  } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const threadKey = scopedThreadKey(threadRef);
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  useEffect(() => {
    if (!canOperateThread && isRenaming) onCancelRename();
  }, [canOperateThread, isRenaming, onCancelRename]);
  const setRowElement = useSidebarRowActionsOverlap();
  const isRegeneratingTitle = thread.titleRegeneration != null;
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const isContextMenuOpen = useSidebarContextMenuTarget((state) => state.threadKey === threadKey);
  const openPrLink = useOpenPrLink();
  // Unsent composer text on this thread. The open thread shows its own
  // composer, so the marker only decorates rows you have navigated away from.
  const hasUnsentDraft = useThreadHasUnsentDraft(threadRef) && !props.isActive;
  const handleDiscardDraftClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      discardComposerDraft(threadRef);
    },
    [threadRef],
  );

  // Same semantics as the legacy sidebar (never-visited counts as read):
  // switching sidebars must not light up every historical thread as unread.
  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarThreadStatus(thread);
  const isInFlight =
    status === "working" || status === "waiting" || status === "approval" || status === "input";
  // A woken thread reappears at its original position (the sort is
  // deliberately static), so the pill has to carry the weight. Snoozing is
  // an explicit act, so the pill clears only when the user re-engages:
  // reading a completion-triggered wake, clicking the pill, sending a
  // message, settling, archiving, or a change request state that settles the
  // thread. Timer wakes survive a mere visit. An unparseable visit timestamp
  // counts as never-visited, so corrupt local data cannot eat the wake signal.
  const lastVisitedDate = lastVisitedAt === undefined ? null : parseTimestampDate(lastVisitedAt);
  const wokeAtDate = props.wokeAt === null ? null : parseTimestampDate(props.wokeAt);
  const isWoke =
    wokeAtDate !== null &&
    (lastVisitedDate === null || lastVisitedDate < wokeAtDate) &&
    thread.settledOverride !== "settled";
  // Background work always recedes when it is not selected: an unread parent
  // completion must not pull a still-working thread back into the foreground.
  // Ready and action-required rows keep their unread and wake prominence.
  const shouldRecede = shouldRecedeSidebarThread({
    status,
    isUnread,
    isWoke,
    isActive: props.isActive,
    isSelected,
  });
  // Status hues follow the system-wide convention set by sidebar v1 and the
  // mobile Live Activity/widgets (amber approval, indigo input, sky working)
  // so a thread reads the same color everywhere it surfaces.
  const topStatus =
    status === "working"
      ? {
          // A native /goal keeps the agent going across turns until it is met.
          label: thread.goal?.status === "active" ? "Goal" : "Working",
          icon: "working" as const,
          // No shimmer: a label that animates forever is noise in a sidebar
          // full of them (and repaints every vsync on high-refresh displays).
          className: "text-info",
        }
      : status === "waiting"
        ? {
            // Waiting is calm background presence (post-settle background
            // roster), not active progress, so the label keeps full strength.
            label: "Waiting",
            icon: "waiting" as const,
            className: "text-muted-foreground",
          }
        : status === "approval"
          ? {
              label: "Approval",
              icon: "approval" as const,
              className: "text-warning-foreground",
            }
          : status === "input"
            ? {
                label: "Input",
                icon: "input" as const,
                className: "text-indigo-600 dark:text-indigo-300",
              }
            : status === "limited"
              ? {
                  label: "Limited",
                  icon: "failed" as const,
                  className: "text-warning",
                }
              : status === "failed"
                ? {
                    label: "Failed",
                    icon: "failed" as const,
                    className: "text-error",
                  }
                : isWoke
                  ? {
                      label: "Woke",
                      icon: "woke" as const,
                      className: "text-warning",
                    }
                  : isUnread
                    ? {
                        label: "Done",
                        icon: "done" as const,
                        className: "text-success",
                      }
                    : null;
  const isWokeStatus = topStatus?.icon === "woke";

  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;
  // The card's provider glyph names the model on hover and to screen readers.
  const providerModelLabel =
    showInstanceBadge && providerEntry
      ? `${modelLabel} · ${providerEntry.displayName}`
      : modelLabel;

  const handleClick = useCallback(
    (event: ReactMouseEvent) => {
      onThreadClick(event, threadRef);
    },
    [onThreadClick, threadRef],
  );
  const handleAcknowledgeWokeClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (props.wokeAt === null) return;
      onAcknowledgeWoke(threadRef, props.wokeAt);
    },
    [onAcknowledgeWoke, props.wokeAt, threadRef],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu, threadRef],
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onThreadActivate(threadRef);
    },
    [onThreadActivate, threadRef],
  );
  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (
        !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) ||
        isRenaming ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      if ((event.target as HTMLElement).closest("button, a, input")) return;
      event.preventDefault();
      onStartRename(threadRef, thread.title);
    },
    [isRenaming, onStartRename, thread.title, threadRef],
  );
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = useMemo(
    () =>
      onFileDropThreads
        ? makeWorkspaceFileDropHandlers({
            setDragActive: setIsFileDragOver,
            addFiles: (files) => {
              onFileDropThreads(threadRef, files);
            },
            addFolders: () => {},
          })
        : null,
    [onFileDropThreads, threadRef],
  );
  useEffect(() => {
    if (!isFileDragOver) return;
    const clearFileDrag = () => setIsFileDragOver(false);
    window.addEventListener("dragend", clearFileDrag);
    return () => window.removeEventListener("dragend", clearFileDrag);
  }, [isFileDragOver]);
  const renameCommittedRef = useRef(false);
  useEffect(() => {
    if (isRenaming) renameCommittedRef.current = false;
  }, [isRenaming]);
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCommitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCancelRename();
      }
    },
    [onCancelRename, onCommitRename, renamingTitle, thread.title, threadRef],
  );
  const handleRenameBlur = useCallback(() => {
    if (!renameCommittedRef.current) {
      onCommitRename(threadRef, renamingTitle, thread.title);
    }
  }, [onCommitRename, renamingTitle, thread.title, threadRef]);
  const { onRegenerateTitle } = props;
  const handleRegenerateTitle = useMemo(
    () =>
      onRegenerateTitle &&
      (() => {
        renameCommittedRef.current = true;
        onRegenerateTitle(threadRef);
      }),
    [onRegenerateTitle, threadRef],
  );
  const handleSettleClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onSettle(threadRef);
    },
    [onSettle, threadRef],
  );
  const handleActionPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (!event.isPrimary || event.button !== 0) return;
      // Action buttons sweep their section rather than picking up the row.
      event.stopPropagation();
      onActionSweepStart(threadRef, variantAction, event.nativeEvent);
    },
    [onActionSweepStart, threadRef, variantAction],
  );
  const handleUnsettleClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnsettle(threadRef);
    },
    [onUnsettle, threadRef],
  );
  const handleUnsnoozeClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnsnooze(threadRef);
    },
    [onUnsnooze, threadRef],
  );
  const handleRowPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (isRenaming || !event.isPrimary || event.button !== 0) return;
      onContextDragStart(threadRef, event.nativeEvent);
    },
    [isRenaming, onContextDragStart, threadRef],
  );
  const handleSnoozePreset = useCallback(
    (preset: Pick<SnoozePreset, "snoozedUntil">) => {
      onSnooze(threadRef, preset);
    },
    [onSnooze, threadRef],
  );
  // While the snooze popover is open the pointer leaves the row, which
  // would fade the hover actions out from under the open menu. Pin them and
  // suppress the row tooltip so its portal cannot overlap the popover.
  const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = useState(false);
  // Snooze is offered only where it can succeed: capability-gated and never
  // on blocked-on-you work or queued turns (the server rejects both).
  // Snoozing is an action on live work; snoozed rows wake and settled rows unsettle.
  const showSnoozeButton =
    variantAction === "settle" &&
    canOperateThread &&
    props.snoozeSupported &&
    canSnooze(thread, { now: new Date().toISOString() });
  // The card's primary hover action: settle live work, wake a snoozed task,
  // unsettle a settled one.
  const showPrimaryAction =
    variantAction === "unsnooze" ? props.snoozeSupported : props.settlementSupported;
  // If the thread becomes blocked while the popover is open, the button
  // unmounts without firing onOpenChange(false). Deriving the flag keeps a
  // stale true from permanently hiding the status label / pinning the
  // hover actions, and the effect clears the raw state so the popover
  // doesn't resurrect if the button later remounts.
  const snoozeMenuOpen = snoozeMenuOpenRaw && showSnoozeButton;
  useEffect(() => {
    if (!showSnoozeButton) setSnoozeMenuOpen(false);
  }, [showSnoozeButton]);

  // All sidebar rows share one surface model. Live threads used to look
  // like elevated cards while settled threads were plain rows, leaving neither
  // a useful hierarchy nor a reliable hover cue. Status now lives in the row
  // content; surface is reserved for interaction (hover, multi-select, route).
  const isCardSelected =
    props.isActive || isSelected || isContextMenuOpen || props.sweepAction !== null;
  const rowSurfaceClassName = cn(
    // The selected card is the same plain lighter surface as a selected chat
    // row. sidebar-row-motion fades the state change and fades the title out
    // under the hover actions (useSidebarRowActionsOverlap).
    SIDEBAR_CARD_CLASS_NAME,
    hasUnsentDraft && SIDEBAR_DRAFT_CLASS_NAME,
    variantAction === "unsettle" &&
      !hasUnsentDraft &&
      "[&:not(:hover):not(:focus-within)_*]:text-secondary-label/70",
    isCardSelected
      ? "state-selected"
      : cn(
          SIDEBAR_CARD_REST_CLASS_NAME,
          shouldRecede && !hasUnsentDraft
            ? "text-sidebar-muted-foreground/75"
            : "text-sidebar-foreground",
        ),
    // Background work fades as a whole row, status label included, so it
    // takes less attention than rows that need a human (input, approval).
    shouldRecede && status === "working" && "opacity-70 hover:opacity-100 focus-within:opacity-100",
    isFileDragOver && "ring-1 ring-inset ring-primary/70",
    isFileDragOver && !props.isActive && !isSelected && "bg-state-hover",
    isContextMenuOpen && "focus-visible:ring-0",
  );
  const sweepBadge =
    props.sweepAction !== null ? (
      <span
        role="status"
        className="pointer-events-none ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-2xs font-medium text-primary"
      >
        {sweepActionBadge[props.sweepAction]}
      </span>
    ) : null;

  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: topStatus?.label ?? null,
    projectDisplayName: props.projectDisplayName,
    agentName: props.workAgentName,
    isActive: props.isActive,
  });

  const title =
    isRenaming && canOperateThread ? (
      <SidebarRenameField
        value={renamingTitle}
        ariaLabel="Thread title"
        onChange={onRenameTitleChange}
        onKeyDown={handleRenameKeyDown}
        onBlur={handleRenameBlur}
        onRegenerate={handleRegenerateTitle}
        fill
        inputClassName="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
      />
    ) : (
      <PendingTitleSlot pending={isRegeneratingTitle} className="min-w-0 flex-1 text-sm">
        <PanOnHoverText
          className={cn(
            "transition-[color,opacity] duration-(--motion-duration-base) motion-reduce:transition-none",
            shouldRecede ? "font-normal" : "font-medium",
            hasUnsentDraft
              ? SIDEBAR_DRAFT_TITLE_CLASS_NAME
              : variant === "card"
                ? cn(
                    // Cards rest in grey and brighten when selected or asking for you.
                    shouldRecede
                      ? "text-secondary-label"
                      : props.isActive || isUnread || isWoke || status === "input"
                        ? "text-foreground"
                        : "text-muted-foreground group-hover/sidebar-row:text-foreground",
                  )
                : cn(
                    "group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground",
                    shouldRecede
                      ? "text-secondary-label/70"
                      : props.isActive || isWoke || status === "input"
                        ? "text-foreground"
                        : isUnread
                          ? "text-muted-foreground"
                          : "text-secondary-label/70",
                  ),
          )}
        >
          <span aria-hidden>{thread.title}</span>
        </PanOnHoverText>
      </PendingTitleSlot>
    );
  const accessibleTitle = isRenaming ? null : <span className="sr-only">{thread.title}</span>;
  // Same pen the new-thread draft rows lead with, so both kinds of unsent
  // work read the same way in the list.
  const draftIndicator = hasUnsentDraft ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label="Unsent draft"
            data-testid={`sidebar-draft-indicator-${thread.id}`}
            className="inline-flex shrink-0 items-center swap-motion"
          />
        }
      >
        <SquarePenIcon aria-hidden className={draftPenClassName} />
      </TooltipTrigger>
      <TooltipPopup side="top">Unsent draft</TooltipPopup>
    </Tooltip>
  ) : null;
  if (variant === "slim") {
    return (
      <li
        data-thread-item={threadKey}
        onPointerDown={handleRowPointerDown}
        {...(fileDropHandlers ?? {})}
        // Matches the h-9 row so unrendered rows never shift the list when they paint.
        className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_36px]"
      >
        <div
          ref={setRowElement}
          role="button"
          tabIndex={0}
          aria-label={accessibility.label}
          aria-current={accessibility.current}
          data-testid="sidebar-row-slim"
          aria-busy={isRegeneratingTitle || undefined}
          className={cn(rowSurfaceClassName, "flex h-9 items-center gap-2.5 px-2.5")}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onKeyDown={handleKeyDown}
          onContextMenu={handleContextMenu}
        >
          {accessibleTitle}
          {/* Settled history recedes: dimmed favicon at rest, restored on
              hover so the tail stays scannable when you're hunting. */}
          <span
            className={cn(
              "flex shrink-0 items-center transition-opacity",
              (!props.isActive || variantAction === "unsettle") &&
                "opacity-40 grayscale group-focus-within/sidebar-row:opacity-100 group-focus-within/sidebar-row:grayscale-0 group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
            )}
          >
            {props.project ? <ProjectFavicon project={props.project} className="size-4" /> : null}
          </span>
          {draftIndicator}
          {title}
          {isRegeneratingTitle ? (
            <span role="status" className="sr-only">
              Regenerating title
            </span>
          ) : null}
          {/* The PR badge stays outside the hover-fading slot: it must
              remain visible AND clickable while the row is hovered. Only
              the time/jump label yields to the settle affordance. */}
          <span
            className={cn(
              "relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end",
              props.sweepAction !== null && "hidden",
            )}
          >
            <span
              className={cn(
                "inline-flex justify-end tabular-nums text-secondary-label transition-opacity duration-(--motion-duration-base) ease-standard motion-reduce:transition-none",
                !isWoke && "group-any-hover/sidebar-row:opacity-0",
              )}
            >
              {variantAction === "unsnooze" && props.snoozeWakeLabelText !== null ? (
                // Snoozed rows show when they come BACK, not when they were
                // last touched — the return ticket is the row's whole story.
                <span className="text-xs text-info-foreground tabular-nums">
                  {props.snoozeWakeLabelText}
                </span>
              ) : isWoke ? (
                // A wake can land straight in the settled tail (e.g. PR
                // merged while snoozed); the signal must survive the trip.
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label="Dismiss Woke notification"
                        onClick={handleAcknowledgeWokeClick}
                        className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs font-medium text-warning-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <AlarmClockIcon aria-hidden className="size-3" />
                        <span role="status">Woke</span>
                      </button>
                    }
                  />
                  <TooltipPopup side="top">Dismiss Woke notification</TooltipPopup>
                </Tooltip>
              ) : (
                <span className="text-xs">
                  {variantAction === "unsettle"
                    ? settledTimeLabel(thread)
                    : threadTimeLabel(thread)}
                </span>
              )}
            </span>
            {variantAction === "unsnooze" ? (
              !props.snoozeSupported ? null : (
                <button
                  type="button"
                  aria-label="Wake thread now"
                  onClick={handleUnsnoozeClick}
                  onPointerDown={handleActionPointerDown}
                  className={cn(
                    "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity duration-(--motion-duration-base) ease-standard motion-reduce:transition-none hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                    isWoke && "group-any-hover/sidebar-row:static",
                  )}
                >
                  <AlarmClockOffIcon className="mb-px size-3" />
                </button>
              )
            ) : !props.settlementSupported ? null : variantAction === "unsettle" ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Unsettle thread"
                      onClick={handleUnsettleClick}
                      onPointerDown={handleActionPointerDown}
                      className={cn(
                        "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity duration-(--motion-duration-base) ease-standard motion-reduce:transition-none hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                        isWoke && "group-any-hover/sidebar-row:static",
                      )}
                    />
                  }
                >
                  <Undo2Icon className="mb-px size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="top">Unsettle thread</TooltipPopup>
              </Tooltip>
            ) : (
              <button
                type="button"
                aria-label="Settle thread"
                onClick={handleSettleClick}
                onPointerDown={handleActionPointerDown}
                className={cn(
                  "pointer-events-none absolute inset-y-0 right-0 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground opacity-0 transition-opacity duration-(--motion-duration-base) ease-standard motion-reduce:transition-none hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                  isWoke && "group-any-hover/sidebar-row:static",
                )}
              >
                <CheckIcon className="size-3" />
              </button>
            )}
          </span>
          {sweepBadge}
          {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
        </div>
      </li>
    );
  }

  const diff = latestRunDiff(thread);

  return (
    <SidebarCardItem
      data-thread-item={threadKey}
      onPointerDown={handleRowPointerDown}
      {...(fileDropHandlers ?? {})}
    >
      <div
        ref={setRowElement}
        role="button"
        tabIndex={0}
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        data-testid="sidebar-row-card"
        data-actions-pinned={snoozeMenuOpen || undefined}
        aria-busy={isRegeneratingTitle || undefined}
        className={rowSurfaceClassName}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
      >
        {accessibleTitle}
        <SidebarCardBody>
          {/* T3's three lines: where it runs and its status, the title, then
              the branch and machine. */}
          <SidebarCardLine line="head">
            <WorkCardLabel
              folder={props.folder}
              repositoryName={props.repositoryName}
              project={props.project}
              projectInHeading={props.projectInHeading}
              onContextMenu={
                props.repositoryName && props.onRepositoryContextMenu
                  ? (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      props.onRepositoryContextMenu?.(
                        scopeProjectRef(thread.environmentId, thread.projectId),
                        { x: event.clientX, y: event.clientY },
                      );
                    }
                  : undefined
              }
            />
            {/* The status owns this slot's width at all times; the hover
                  actions (on hover, keyboard focus or while the snooze menu
                  is open) cross-fade in over it, absolutely layered, so the
                  line never reflows. Where the actions are wider they reach
                  over the label's end, which fades out under them
                  (--sidebar-row-actions-overlap). Woke keeps its pill, so
                  there the actions take their own width beside it. */}
            <span
              className={cn(
                "group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs",
                props.sweepAction !== null && "hidden",
              )}
            >
              {/* Read-only status labels yield to the hover actions. Woke is
                  itself an action, so it stays pointer-enabled and visible
                  while the other controls appear beside it. */}
              <span
                className={cn(
                  isWokeStatus
                    ? "pointer-events-auto"
                    : "pointer-events-none group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-any-hover/sidebar-row:opacity-0",
                  "flex items-center self-center justify-self-end tabular-nums text-secondary-label transition-opacity duration-(--motion-duration-base) ease-standard motion-reduce:transition-none",
                  snoozeMenuOpen && "pointer-events-none opacity-0",
                )}
              >
                {variantAction === "unsnooze" &&
                props.snoozeWakeLabelText !== null &&
                !isWokeStatus ? (
                  // Snoozed tasks show when they come back.
                  <span key="wake" className="swap-motion text-info-foreground">
                    {props.snoozeWakeLabelText}
                  </span>
                ) : topStatus ? (
                  isWokeStatus ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label="Dismiss Woke notification"
                            onClick={handleAcknowledgeWokeClick}
                            className={cn(
                              "inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                              topStatus.className,
                            )}
                          >
                            <AlarmClockIcon aria-hidden className="size-4 shrink-0" />
                            <span role="status">{topStatus.label}</span>
                          </button>
                        }
                      />
                      <TooltipPopup side="top">Dismiss Woke notification</TooltipPopup>
                    </Tooltip>
                  ) : (
                    <span
                      // Keyed by state so a status change swaps in with a fade.
                      key={topStatus.icon}
                      className={cn(
                        "inline-flex items-center gap-1 font-medium swap-motion",
                        topStatus.className,
                      )}
                    >
                      {topStatus.icon === "working" ? (
                        <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
                      ) : topStatus.icon === "waiting" ? (
                        <CircleDotDashedIcon aria-hidden className="size-4 shrink-0" />
                      ) : topStatus.icon === "input" ? (
                        <MessageCircleQuestionIcon aria-hidden className="size-4 shrink-0" />
                      ) : topStatus.icon === "approval" ? (
                        <ShieldQuestionIcon aria-hidden className="size-4 shrink-0" />
                      ) : topStatus.icon === "failed" ? (
                        <CircleAlertIcon aria-hidden className="size-4 shrink-0" />
                      ) : topStatus.icon === "done" ? (
                        <CircleCheckIcon aria-hidden className="size-4 shrink-0" />
                      ) : null}
                      {/* The label alone is the live region: a role="status"
                          wrapper around the ticking duration would make
                          screen readers announce every second. */}
                      <span role="status">{topStatus.label}</span>
                      {status === "working" ? (
                        <span aria-hidden>
                          <WorkingDuration startedAt={resolveWorkingStartedAt(thread)} />
                        </span>
                      ) : status === "waiting" ? (
                        // Waiting starts when the turn ends and background
                        // work keeps the thread held.
                        <span aria-hidden>
                          <WorkingDuration startedAt={thread.latestRun?.completedAt ?? null} />
                        </span>
                      ) : null}
                    </span>
                  )
                ) : (
                  <span key="time" className="swap-motion">
                    {variantAction === "unsettle"
                      ? settledTimeLabel(thread)
                      : threadTimeLabel(thread)}
                  </span>
                )}
              </span>
              {showPrimaryAction || showSnoozeButton || hasUnsentDraft ? (
                <span
                  data-row-hover-actions=""
                  className={cn(
                    // focus-visible, not focus-within: a mouse click leaves
                    // the Settle button focused, and a plain focus-within
                    // would keep the controls pinned over the status label
                    // once the pointer moves away (e.g. after a failed
                    // settle) instead of cross-fading back.
                    "pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 transition-opacity duration-(--motion-duration-base) ease-standard motion-reduce:transition-none has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                    isWokeStatus &&
                      "has-[:focus-visible]:static group-any-hover/sidebar-row:static",
                    snoozeMenuOpen && "pointer-events-auto opacity-100",
                    snoozeMenuOpen && isWokeStatus && "static",
                  )}
                >
                  {hasUnsentDraft ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label="Discard draft"
                            onClick={handleDiscardDraftClick}
                            className="inline-flex cursor-pointer items-center rounded-md bg-transparent px-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                          />
                        }
                      >
                        <XIcon className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipPopup side="top">Discard draft</TooltipPopup>
                    </Tooltip>
                  ) : null}
                  {showSnoozeButton ? (
                    <SnoozeMenuButton
                      open={snoozeMenuOpen}
                      onOpenChange={setSnoozeMenuOpen}
                      onSnooze={handleSnoozePreset}
                      timestampFormat={props.timestampFormat}
                    />
                  ) : null}
                  {showPrimaryAction ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label={
                              variantAction === "unsnooze"
                                ? "Wake thread now"
                                : variantAction === "unsettle"
                                  ? "Unsettle thread"
                                  : "Settle thread"
                            }
                            onClick={
                              variantAction === "unsnooze"
                                ? handleUnsnoozeClick
                                : variantAction === "unsettle"
                                  ? handleUnsettleClick
                                  : handleSettleClick
                            }
                            onPointerDown={handleActionPointerDown}
                            className="-mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                          />
                        }
                      >
                        {variantAction === "unsnooze" ? (
                          <>
                            <AlarmClockOffIcon className="size-3.5" />
                            Wake
                          </>
                        ) : variantAction === "unsettle" ? (
                          <>
                            <Undo2Icon className="size-3.5" />
                            Unsettle
                          </>
                        ) : (
                          <>
                            <CheckIcon className="size-3.5" />
                            Settle
                          </>
                        )}
                      </TooltipTrigger>
                      <TooltipPopup>
                        {variantAction === "unsnooze"
                          ? "Wake thread now"
                          : variantAction === "unsettle"
                            ? "Unsettle thread"
                            : "Settle thread"}
                      </TooltipPopup>
                    </Tooltip>
                  ) : null}
                </span>
              ) : null}
            </span>
            {/* A sweep hides the slot rather than unmounting it, so the
                  pressed action button stays connected and a cancelled sweep's
                  release click still fires and is consumed. */}
            {sweepBadge}
          </SidebarCardLine>
          {/* The hover actions sit on the first line, so the title never fades under them. */}
          <SidebarCardLine line="title" className="[--pan-end-inset-target:0px]">
            {draftIndicator}
            {title}
          </SidebarCardLine>
          {isRegeneratingTitle ? (
            <span role="status" className="sr-only">
              Regenerating title
            </span>
          ) : null}
          <SidebarCardLine line="meta" tone="faint">
            {/* Work an agent started names the agent ahead of the branch. */}
            {props.workAgentName ? (
              <span className="flex min-w-0 max-w-1/2 shrink-0 items-center gap-1">
                <BotIcon aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{props.workAgentName}</span>
              </span>
            ) : null}
            {/* Always the branch: the plan step used to take this slot while
                  working, but it truncated to a half-sentence and dropped the
                  branch, the row's most stable identifier. A worktree swaps
                  the branch glyph for its own icon. */}
            {thread.branch ? (
              <>
                {thread.worktreePath?.trim() ? (
                  <ThreadWorktreeIndicator thread={thread} />
                ) : (
                  <GitBranchIcon aria-hidden className="size-3 shrink-0" />
                )}
                <span className="min-w-0 flex-1 fade-truncate">{thread.branch}</span>
              </>
            ) : (
              <span className="flex-1" />
            )}
            {props.showWorkStatus ? <WorkRowStatusMarker thread={thread} /> : null}

            {diff ? (
              <span className="shrink-0 font-mono">
                <span className="text-diff-addition-foreground">
                  +{formatDiffCount(diff.insertions)}
                </span>{" "}
                <span className="text-diff-deletion-foreground">
                  −{formatDiffCount(diff.deletions)}
                </span>
              </span>
            ) : null}
            {/* The environment the thread runs in, always named (even with
                  one machine), then the provider glyph, which names the model. */}
            <span className="ml-auto inline-flex min-w-0 items-center gap-1.5">
              {props.environmentLabel ? (
                <span className="inline-flex min-w-0 max-w-24 items-center gap-1">
                  <EnvironmentMachineIcon
                    aria-hidden
                    kind={props.environmentMachine}
                    className="size-3 shrink-0"
                  />
                  <span className="truncate">{props.environmentLabel}</span>
                </span>
              ) : null}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      role="img"
                      aria-label={`Model: ${providerModelLabel}`}
                      className="inline-flex shrink-0 items-center"
                    />
                  }
                >
                  <SidebarProviderStack
                    thread={thread}
                    providerEntryByInstanceId={props.providerEntryByInstanceId}
                    selected={isCardSelected}
                  />
                </TooltipTrigger>
                <TooltipPopup side="top">{providerModelLabel}</TooltipPopup>
              </Tooltip>
            </span>
          </SidebarCardLine>
        </SidebarCardBody>
        {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
      </div>
    </SidebarCardItem>
  );
});

function latestRunDiff(
  thread: SidebarThreadSummary,
): { insertions: number; deletions: number } | null {
  // Shells don't carry checkpoint summaries; diff stats render only when the
  // shell projection grows them. Kept as a seam so the row layout is ready.
  void thread;
  return null;
}

const SidebarSearchResultRow = memo(function SidebarSearchResultRow(props: {
  showProjectIcon: boolean;
  isSettled: boolean;
  thread: SidebarThreadSummary;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  isHighlighted: boolean;
  isRouteActive: boolean;
  resultId: string;
  searchMatch: EnvironmentThreadSearchMatch | null;
  searchQuery: string;
  onHighlight: () => void;
  onSelect: () => void;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
}) {
  const { thread } = props;
  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: null,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isRouteActive,
  });
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = useMemo(
    () =>
      makeWorkspaceFileDropHandlers({
        setDragActive: setIsFileDragOver,
        addFiles: (files) => {
          props.onFileDropThreads(threadRef, files);
        },
        addFolders: () => {},
      }),
    [props.onFileDropThreads, threadRef],
  );
  useEffect(() => {
    if (!isFileDragOver) return;
    const clearFileDrag = () => setIsFileDragOver(false);
    window.addEventListener("dragend", clearFileDrag);
    return () => window.removeEventListener("dragend", clearFileDrag);
  }, [isFileDragOver]);
  return (
    <li role="presentation" className="list-none" {...fileDropHandlers}>
      <button
        id={props.resultId}
        type="button"
        role="option"
        // aria-activedescendant options: focus stays on the search input,
        // which owns all keyboard interaction for the listbox.
        tabIndex={-1}
        aria-selected={props.isHighlighted}
        aria-current={accessibility.current}
        aria-describedby={`${props.resultId}-pr`}
        aria-label={accessibility.label}
        onMouseMove={props.onHighlight}
        onClick={props.onSelect}
        className={cn(
          "group/sidebar-row group/v2-row flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1 text-left text-sm outline-none",
          props.isHighlighted || props.isRouteActive
            ? "state-selected"
            : "state-hover text-sidebar-muted-foreground/75",
          isFileDragOver && "ring-1 ring-inset ring-primary/70",
          isFileDragOver && !props.isRouteActive && "bg-state-hover",
        )}
      >
        {props.project && props.showProjectIcon ? (
          <ProjectFavicon
            project={props.project}
            className={cn(
              "size-4 shrink-0 transition-opacity",
              props.isSettled &&
                !props.isRouteActive &&
                !props.isHighlighted &&
                "opacity-40 grayscale group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
            )}
          />
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2.5">
            <PendingTitleSlot pending={thread.titleRegeneration != null} className="min-w-0 flex-1">
              <PanOnHoverText
                className={cn(
                  props.isSettled
                    ? "font-normal text-secondary-label/70 group-hover/sidebar-row:text-foreground"
                    : "font-medium text-foreground",
                  (props.isHighlighted || props.isRouteActive) && "text-foreground",
                )}
              >
                {thread.title}
              </PanOnHoverText>
            </PendingTitleSlot>
            <span id={`${props.resultId}-pr`} className="contents"></span>
            <span className="w-8 shrink-0 text-right text-xs text-muted-foreground/55 tabular-nums">
              {threadTimeLabel(thread)}
            </span>
          </span>
          {props.searchMatch ? (
            <ThreadSearchMatchExcerpt
              match={{
                source: props.searchMatch.source,
                snippet: props.searchMatch.snippet,
                query: props.searchQuery,
              }}
            />
          ) : null}
        </span>
      </button>
    </li>
  );
});

export default function Sidebar() {
  const projects = useProjects();
  const threads = useThreadShells();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  // AppSidebarLayout shows the navigation rail beside this sidebar on wider
  // windows (the legacy sidebar never mounts this component).
  const navRailVisible = !isMobile;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const workingShelfEnabled = useClientSettings((s) => s.sidebarWorkingShelfEnabled);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    reorderPinnedThread,
    reorderActiveThread,
    markThreadUnread,
    markThreadRead,
    archiveThread,
    deleteThread,
  } = useThreadActions();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      showCopiedToast({ kind: "path", path });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      showCopiedToast({ kind: "branch", branch });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy branch",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyThreadLinkToClipboard } = useCopyToClipboard<{ link: string }>({
    onCopy: ({ link }) => {
      showCopiedToast({ kind: "thread-link", link });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread link",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
    threadTitle: string;
  }>({
    onCopy: ({ threadId, threadTitle }) => {
      showCopiedToast({ kind: "thread-id", threadId, threadTitle });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const newThreadContext = useHandleNewThread();
  const openAddProjectCommandPalette = useCallback(
    () => openCommandPalette({ open: "add-project" }),
    [],
  );
  const environments = useEnvironmentIdentities();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const acknowledgeWoke = useAcknowledgeThreadWoke();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = useMemo(
    () => resolveActiveThreadRouteRef(routeTarget, routeDraftThread),
    [routeDraftThread, routeTarget],
  );
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeTargetRef = useRef(routeTarget);
  routeTargetRef.current = routeTarget;
  // Post-settle navigation validates against the CURRENT route, not the one
  // captured when the settle started: if the user navigated elsewhere while
  // the command was in flight, completing it must not yank them away.
  const routeThreadKeyRef = useRef(routeThreadKey);
  routeThreadKeyRef.current = routeThreadKey;

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const environmentMachineById = useEnvironmentMachines();
  const projectGroups = useSidebarProjectGroups();
  const projectGroupsRef = useRef(projectGroups);
  projectGroupsRef.current = projectGroups;
  // Threads on non-primary environments (Cogenly Connect, hosted) resolve their
  // provider entry from their own environment's config: default instance ids
  // are driver slugs, so a flat map would collide across environments.
  const providerEntriesByEnvironment = useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...serverConfigs].map(
          ([environmentId, config]) => [environmentId, config.providers, config.settings] as const,
        ),
      ),
    [serverConfigs],
  );
  // Rows read the project record for its icon and cwd. Group labels can include
  // a repository owner or a different title, so they travel separately.
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  const projectDisplayNameByKey = useMemo(
    () =>
      new Map(
        projectGroups.flatMap((group) =>
          group.memberProjects.map(
            (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
          ),
        ),
      ),
    [projectGroups],
  );

  const nowMinute = useNowMinute();
  // Snooze wake times are second-precise, so classifying with the quantized
  // minute would hold a woken thread on the shelf for up to a minute. The
  // tick is a plain counter bumped exactly at the next wake boundary (armed
  // below, after the partition knows the boundary); the partition reads a
  // fresh clock whenever it recomputes.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);

  // The repository a Work row names on its meta line; scratch work has none.
  const repositoryNameFor = (thread: Pick<SidebarThreadSummary, "environmentId" | "projectId">) => {
    const projectKey = `${thread.environmentId}:${thread.projectId}` as const;
    const project = projectByKey.get(projectKey);
    if (
      !project ||
      isScratchProject(project, serverConfigs.get(thread.environmentId)?.scratchWorkspaceRoot)
    ) {
      return null;
    }
    return projectDisplayNameByKey.get(projectKey) ?? project.title;
  };
  // Project folders hold chats and Work, across environments.
  const labelEnvironmentIds = useConnectedEnvironmentIds();
  const projectLabelDirectory = useProjectLabelDirectory(labelEnvironmentIds);
  const moveThreadToFolder = useMoveThreadToFolder();
  // Chats | Work | Agents: the list below shows one mode's threads at a time.
  const sidebarModes = useSidebarModeState({
    threads,
    projects,
    serverConfigs,
    scopedProjectKeys: null,
    routeThreadRef,
    routeDraftId: routeTarget?.kind === "draft" ? routeTarget.draftId : null,
    keybindings,
    projectDisplayNameByKey,
  });
  const sidebarMode = sidebarModes.mode;
  // Chats and Work list threads; Agents renders its own list.
  const modeListsThreads = sidebarMode === "chats" || sidebarMode === "tasks";
  // Rows name their folder in the hover card. One object per folder, so
  // memoized rows keep the same prop while the directory holds.
  const folderFor = useMemo(() => {
    const byKey = new Map<string, SidebarRowFolder>();
    for (const entry of projectLabelDirectory.labels) {
      byKey.set(entry.key, { name: entry.label.name, color: entry.label.color });
    }
    return (thread: SidebarThreadSummary): SidebarRowFolder | null => {
      const folderId = threadProjectFolderId(thread);
      return folderId === null
        ? null
        : (byKey.get(projectLabelKey(thread.environmentId, folderId)) ?? null);
    };
  }, [projectLabelDirectory]);
  // Work cards name their project: an explicit filing, else the project their
  // repository is in now, so filing a repository shows on its Work at once.
  // One stable object per project, so memoized cards skip unchanged renders.
  const rowFolderByKey = useMemo(
    () =>
      new Map(
        projectLabelDirectory.labels.map(
          (entry) => [entry.key, { name: entry.label.name, color: entry.label.color }] as const,
        ),
      ),
    [projectLabelDirectory],
  );
  const workFolderFor = useCallback(
    (thread: SidebarThreadSummary): SidebarRowFolder | null => {
      const entry = workThreadFolder(thread, projectLabelDirectory);
      return entry ? (rowFolderByKey.get(entry.key) ?? null) : null;
    },
    [projectLabelDirectory, rowFolderByKey],
  );
  const repositoryFolderFor = useCallback(
    (environmentId: EnvironmentId, projectId: ProjectId): SidebarRowFolder | null => {
      const entry = projectLabelDirectory.folderByRepository.get(
        scopedRepositoryKey(environmentId, projectId),
      );
      return entry ? (rowFolderByKey.get(entry.key) ?? null) : null;
    },
    [projectLabelDirectory, rowFolderByKey],
  );
  const folderForLabel = useCallback(
    (environmentId: EnvironmentId, labelId: ProjectLabelId): SidebarRowFolder | null =>
      rowFolderByKey.get(projectLabelKey(environmentId, labelId)) ?? null,
    [rowFolderByKey],
  );
  const chatProjectMetaAnimates = useChatProjectMetaAnimates(
    projectLabelDirectory.labels.length > 0,
  );
  const setNavRailDecisionsWaiting = useNavRailBadgeStore((store) => store.setDecisionsWaiting);
  useEffect(() => {
    setNavRailDecisionsWaiting(sidebarModes.decisionsWaiting);
  }, [setNavRailDecisionsWaiting, sidebarModes.decisionsWaiting]);
  const sidebarModeActions = useSidebarModeActions({
    mode: sidebarMode,
    currentEnvironmentId: routeThreadRef?.environmentId ?? primaryEnvironmentId,
  });
  // Count-only subscription: the parent needs "are there draft rows" for the
  // empty state, while SidebarDraftBlock owns the per-keystroke content
  // subscription. Selecting a number keeps typing in a draft composer from
  // re-rendering the whole sidebar. Approximates the block's row filter
  // (every non-promoted session with content); it can overcount by one for
  // an open never-left draft, which only softens the empty state.
  const routeDraftIdForRows = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const visibleDraftSessionCount = useComposerDraftStore((store) => {
    let count = 0;
    for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      if (!composerDraftHasUserContent(store.draftsByThreadKey[draftKey])) {
        continue;
      }
      if (!sidebarModes.draftInMode(session)) {
        continue;
      }
      count += 1;
    }
    return count;
  });
  // Work files each draft under its repository like any card, so the list
  // needs which drafts exist, not their text: a signature typing never
  // changes. The open draft is listed only if it had content at route entry
  // (the card is frozen then, as in SidebarDraftBlock); an empty one would
  // leave its repository heading with nothing under it.
  // Whether the open draft had content when it became the route, captured
  // synchronously on route change like the card's own frozen snapshot.
  const [routeDraftEntry, setRouteDraftEntry] = useState<{
    draftId: string | null;
    hadContent: boolean;
  }>({ draftId: null, hadContent: false });
  if (routeDraftEntry.draftId !== routeDraftIdForRows) {
    setRouteDraftEntry({
      draftId: routeDraftIdForRows,
      hadContent:
        routeDraftIdForRows !== null &&
        composerDraftHasUserContent(
          useComposerDraftStore.getState().draftsByThreadKey[routeDraftIdForRows],
        ),
    });
  }
  const workDraftSignature = useComposerDraftStore((store) => {
    if (sidebarMode !== "tasks") return "";
    const parts: string[] = [];
    for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
      if (session.promotedTo != null || !sidebarModes.draftInMode(session)) continue;
      if (
        !shouldListWorkDraft({
          isRouteDraft: draftKey === routeDraftIdForRows,
          routeDraftHadContentOnEntry:
            routeDraftEntry.draftId === draftKey && routeDraftEntry.hadContent,
          hasContent: composerDraftHasUserContent(store.draftsByThreadKey[draftKey]),
        })
      ) {
        continue;
      }
      parts.push(
        [
          draftKey,
          session.environmentId,
          session.projectId,
          session.createdAt,
          session.branch ?? "",
          session.threadId,
        ].join("\t"),
      );
    }
    return parts.join("\n");
  });
  const workDrafts = useMemo(
    () =>
      workDraftSignature === ""
        ? []
        : workDraftSignature.split("\n").map((line) => {
            const [draftId, environmentId, projectId, createdAt, branch, threadId] =
              line.split("\t");
            return {
              draftId: DraftId.make(draftId!),
              environmentId: environmentId as EnvironmentId,
              projectId: projectId as ProjectId,
              createdAtMs: Date.parse(createdAt!) || 0,
              branch: branch || null,
              threadId: threadId as ThreadId,
            };
          }),
    [workDraftSignature],
  );
  // Mode flips drop the selection: rows selected under the old mode are
  // hidden now, and bulk actions must never count or touch invisible rows.
  useEffect(() => {
    clearSelection();
  }, [clearSelection, sidebarMode]);

  const openProjectView = useStableCallback(
    (project: { environmentId: EnvironmentId; label: { id: ProjectLabelId } }) => {
      if (isMobile) setOpenMobile(false);
      void router.navigate({
        to: "/project/$environmentId/$labelId",
        params: { environmentId: project.environmentId, labelId: project.label.id },
      });
    },
  );
  const openProjectSettings = useStableCallback(
    (projectGroup: SidebarProjectSnapshot, projectRef?: ScopedProjectRef) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/projects/$projectKey",
        params: {
          projectKey: getSidebarProjectSettingsKey(
            projectGroup,
            projectGroupingSettings,
            projects,
            projectRef,
          ),
        },
      });
    },
  );
  const { activeThreads, workingThreads, snoozedThreads, settledThreads, snoozeNow } =
    useMemo(() => {
      // Snooze classification uses a REAL clock, not the quantized minute:
      // wake times are second-precise and a woken thread must not linger on
      // the shelf for the rest of the minute. snoozeWakeTick re-runs this
      // memo exactly at the next wake boundary.
      void snoozeWakeTick;
      const preciseNow = new Date().toISOString();
      // Subagent child threads live in the parent's Agents surface, not the
      // sidebar roster (v2 models them as real threads with lineage).
      const visible = filterSidebarV2VisibleThreads(sidebarModes.modeThreads, null);
      inboxReturns.observe(workingShelfEnabled ? threads : null);
      const active: EnvironmentThreadShell[] = [];
      const working: EnvironmentThreadShell[] = [];
      // Working beta: only inbox threads fold away. Snoozed and settled
      // threads keep their shelves. Work lists running tasks with the rest:
      // its first filter is all tasks.
      const inbox = (thread: EnvironmentThreadShell) =>
        workingShelfEnabled && sidebarMode !== "tasks" && isSidebarThreadWorking(thread)
          ? working
          : active;
      const snoozed: EnvironmentThreadShell[] = [];
      const settled: EnvironmentThreadShell[] = [];
      for (const thread of visible) {
        // Chats are one plain list by date: no working, snoozed or settled
        // shelves, so a chat never hides behind lifecycle it can't show.
        if (sidebarMode === "chats") {
          active.push(thread);
          continue;
        }
        const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
        // Threads on servers without the settlement capability (old server,
        // or descriptor not loaded yet) never classify as settled: the user
        // could not un-settle them, so auto-settling them would strand rows in
        // a tail with no working affordances.
        const supportsSettlement = capabilities?.threadSettlement === true;
        const supportsSnooze = capabilities?.threadSnooze === true;
        const section = resolveSidebarThreadSection({
          snoozed: supportsSnooze && effectiveSnoozed(thread, { now: preciseNow }),
          settled: supportsSettlement && thread.settledOverride === "settled",
        });
        (section === "snoozed" ? snoozed : section === "settled" ? settled : inbox(thread)).push(
          thread,
        );
      }
      // Chats lead with their pins, then read newest first under date
      // headings. Work follows the order the user arranged by dragging
      // (activeOrderKey, synced through the server), new work first.
      const sortedActive =
        sidebarMode === "chats"
          ? orderChatsWithPins(active)
          : sidebarMode === "tasks"
            ? sortActiveThreadsByOrderKey(active)
            : workingShelfEnabled
              ? sortInboxThreadsByReturn(active, inboxReturns.returnedAt)
              : sortThreadsForSidebar(active);
      return {
        activeThreads: sortedActive,
        // Newest send first; finishing and waking again do not move a row.
        workingThreads: sortWorkingThreadsBySend(working),
        // Soonest wake first: "what comes back next" is the shelf's question.
        snoozedThreads: snoozed.toSorted(
          (left, right) =>
            firstValidTimestampMs(left.snoozedUntil ?? null) -
            firstValidTimestampMs(right.snoozedUntil ?? null),
        ),
        settledThreads: sortSettledThreads(settled),
        snoozeNow: preciseNow,
      };
    }, [
      nowMinute,
      serverConfigs,
      sidebarMode,
      sidebarModes.modeThreads,
      snoozeWakeTick,
      threads,
      workingShelfEnabled,
    ]);

  // Chats render a page at a time; the sentinel after the last row reveals
  // the next page as it scrolls into view. Every chat summary is already in
  // the shell, so this only bounds rendering. Each mode keeps the pages it
  // revealed, so coming back lands on the same rows.
  const { count: chatVisibleCount, reveal: revealMoreChats } = useSidebarListReveal({
    listKey: "chats",
    resetKey: sidebarMode,
    initialCount: CHAT_LIST_PAGE_SIZE,
    pageCount: CHAT_LIST_PAGE_SIZE,
  });
  // While a pinned chat is dragged, Pinned previews the drop order; the list
  // motion glides rows between slots as the order changes.
  const [pinDrag, setPinDrag] = useState<{ key: string; order: readonly string[] } | null>(null);
  // While a Work card's move saves (a drop, or alt+arrow), the Working list
  // draws this order, so the card never jumps back before the server agrees.
  // `settled` once its writes are saved, while the rows catch up.
  const [workDrag, setWorkDrag] = useState<{
    key: string;
    order: readonly string[];
    settled?: boolean;
  } | null>(null);
  const chatWindow = useMemo(
    () =>
      sidebarMode === "chats"
        ? windowChatList(
            pinDrag
              ? applyPinnedDragOrder(activeThreads, pinDrag.order, (thread) =>
                  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                )
              : activeThreads,
            chatVisibleCount,
            (thread) =>
              routeThreadKey !== null &&
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
          )
        : null,
    [activeThreads, chatVisibleCount, pinDrag, routeThreadKey, sidebarMode],
  );
  const renderedActiveThreads = chatWindow?.visible ?? activeThreads;

  const threadSearchInputRef = useRef<HTMLInputElement>(null);
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0);
  const isSearchingThreads = threadSearchQuery.trim().length > 0;
  const searchableThreads = useMemo(
    () => [...activeThreads, ...workingThreads, ...snoozedThreads, ...settledThreads],
    [activeThreads, settledThreads, snoozedThreads, workingThreads],
  );
  const searchEnvironmentIds = useConnectedEnvironmentIds();
  // useThreadSearch owns the debounce and the two-character floor.
  const threadSearch = useThreadSearch(searchEnvironmentIds, threadSearchQuery);
  const threadSearchMatchByKey = useMemo(
    () =>
      new Map(threadSearch.matches.map((match) => [threadSearchMatchKey(match), match] as const)),
    [threadSearch.matches],
  );
  const threadSearchResults = useMemo(
    () =>
      searchSidebarThreads(
        searchableThreads,
        threadSearchQuery,
        new Set(threadSearchMatchByKey.keys()),
      ),
    [searchableThreads, threadSearchQuery, threadSearchMatchByKey],
  );
  const threadSearchResultOrderKey = threadSearchResults
    .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))
    .join("\0");

  useEffect(() => {
    setActiveSearchResultIndex(0);
  }, [threadSearchResultOrderKey]);

  useEffect(() => {
    if (!isSearchingThreads) return;
    document
      .getElementById(`sidebar-thread-search-result-${activeSearchResultIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSearchResultIndex, isSearchingThreads, threadSearchResultOrderKey]);

  // Arm a timeout for the earliest upcoming wake so the shelf empties the
  // moment a snooze expires instead of on the next minute tick. Sorted
  // soonest-first, so entry 0 is the boundary.
  useEffect(() => {
    const nextWakeAtMs =
      snoozedThreads.length > 0 && snoozedThreads[0]?.snoozedUntil != null
        ? Date.parse(snoozedThreads[0].snoozedUntil)
        : Number.NaN;
    if (Number.isNaN(nextWakeAtMs)) return;
    // setTimeout delays are signed 32-bit: anything larger overflows and
    // fires immediately, turning a far-future wake (event-condition snoozes
    // synced from elsewhere) into a tight re-arm loop. Clamped, the timer
    // just re-arms every ~24.8 days until the wake is in range.
    const delayMs = Math.min(Math.max(0, nextWakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = window.setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => window.clearTimeout(id);
  }, [snoozedThreads]);

  // The settled tail renders in pages: history shouldn't dominate the
  // sidebar, and the common lookups are recent. The sentinel above its
  // oldest row (the list grows upward) reveals the next page as it scrolls
  // into view. Each mode keeps the pages it revealed.
  const { count: settledVisibleCount, reveal: revealMoreSettled } = useSidebarListReveal({
    listKey: "settled",
    resetKey: sidebarMode,
    initialCount: SETTLED_TAIL_INITIAL_COUNT,
    pageCount: SETTLED_TAIL_PAGE_COUNT,
  });
  const visibleSettledThreads = useMemo(() => {
    if (settledThreads.length <= settledVisibleCount) return settledThreads;
    const visible = settledThreads.slice(0, settledVisibleCount);
    // The open thread must never hide in the unrevealed tail: navigating into a
    // deep settled thread (search, deep link) pulls its row into the visible
    // tail so the highlight and the un-settle affordance stay reachable.
    if (routeThreadKey !== null) {
      const routeThread = settledThreads
        .slice(settledVisibleCount)
        .find(
          (thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
        );
      if (routeThread !== undefined) visible.push(routeThread);
    }
    return visible;
  }, [routeThreadKey, settledThreads, settledVisibleCount]);
  const hiddenSettledCount = settledThreads.length - visibleSettledThreads.length;
  const [settledShelfExpanded, setSettledShelfExpanded] = useLocalStorage(
    SETTLED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const toggleSettledShelf = useCallback(
    () => setSettledShelfExpanded((value) => !value),
    [setSettledShelfExpanded],
  );
  const renderedSettledThreads = useMemo(() => {
    if (settledShelfExpanded) return visibleSettledThreads;
    if (routeThreadKey === null) return EMPTY_THREADS;
    const routeThread = visibleSettledThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    );
    return routeThread === undefined ? EMPTY_THREADS : [routeThread];
  }, [routeThreadKey, settledShelfExpanded, visibleSettledThreads]);

  // The snoozed shelf is collapsed by default: out of the way, never gone.
  // Collapsed threads don't render (and so don't participate in jump
  // shortcuts or multi-select), matching the settled tail's paging model.
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useLocalStorage(
    SNOOZED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const toggleSnoozedShelf = useCallback(
    () => setSnoozedShelfExpanded((value) => !value),
    [setSnoozedShelfExpanded],
  );
  const visibleSnoozedThreads = useMemo(() => {
    if (snoozedShelfExpanded) return snoozedThreads;
    // The open thread must never vanish behind the collapsed shelf: a
    // snoozed thread reached by route (deep link, open before snoozing
    // elsewhere) keeps its row — with highlight and wake affordance — same
    // exception the settled tail's paging makes.
    if (routeThreadKey === null) return EMPTY_THREADS;
    const routeThread = snoozedThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    );
    return routeThread === undefined ? EMPTY_THREADS : [routeThread];
  }, [routeThreadKey, snoozedShelfExpanded, snoozedThreads]);

  // The Working shelf (beta) collapses the same way, with the same route
  // exception: sending a message folds the open thread into the shelf, and
  // its row must stay visible there.
  const [workingShelfExpanded, setWorkingShelfExpanded] = useLocalStorage(
    WORKING_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const toggleWorkingShelf = useCallback(
    () => setWorkingShelfExpanded((value) => !value),
    [setWorkingShelfExpanded],
  );
  // Work's "Needs attention" filter: the tasks waiting on the user.
  const [attentionFilterOpen, setAttentionFilterOpen] = useLocalStorage(
    ATTENTION_FILTER_OPEN_KEY,
    false,
    Schema.Boolean,
  );
  // The count bar shows one filter at a time; opening one closes the others.
  const requestedShelf: SidebarShelf | null = attentionFilterOpen
    ? "attention"
    : snoozedShelfExpanded
      ? "snoozed"
      : settledShelfExpanded
        ? "settled"
        : null;
  const openSidebarShelf = useCallback(
    (shelf: SidebarShelf | null) => {
      setAttentionFilterOpen(shelf === "attention");
      setSnoozedShelfExpanded(shelf === "snoozed");
      setSettledShelfExpanded(shelf === "settled");
    },
    [setAttentionFilterOpen, setSettledShelfExpanded, setSnoozedShelfExpanded],
  );
  const attentionThreadKeys = useMemo(() => {
    const keys = new Set<string>();
    if (sidebarMode !== "tasks") return keys;
    for (const thread of activeThreads) {
      if (isSidebarThreadAwaitingUser(thread)) {
        keys.add(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)));
      }
    }
    return keys;
  }, [activeThreads, sidebarMode]);
  // A filter never opens onto nothing: an empty one falls back to the first
  // filter in bar order that holds something (see useSegmentSelection).
  const shelfIndex = useSegmentSelection(
    sidebarMode === "tasks"
      ? [
          activeThreads.length,
          attentionThreadKeys.size,
          snoozedThreads.length,
          settledThreads.length,
        ]
      : [null, null, null, null],
    WORK_SHELF_ORDER.indexOf(requestedShelf),
    (index) => openSidebarShelf(WORK_SHELF_ORDER[index] ?? null),
  );
  const openShelf: SidebarShelf | null = WORK_SHELF_ORDER[shelfIndex] ?? null;
  // Folded group headings, per space: Chats' date groups, Work's projects.
  const [collapsedSections, setCollapsedSections] = useLocalStorage(
    COLLAPSED_SECTIONS_KEY,
    EMPTY_COLLAPSED_SECTIONS,
    CollapsedSections,
  );
  const collapsedInSpace = collapsedSections[sidebarMode] ?? EMPTY_SECTION_KEYS;
  const toggleSection = useCallback(
    (key: string) =>
      setCollapsedSections((current) => toggleCollapsedSection(current, sidebarMode, key)),
    [setCollapsedSections, sidebarMode],
  );
  // Chats' date headings count every chat they hold, not just the rendered page.
  const { chatDateGroupCounts, chatDateGroupByKey } = useMemo(() => {
    void nowMinute;
    const byKey = new Map<string, ChatListGroup>();
    if (sidebarMode !== "chats")
      return { chatDateGroupCounts: new Map<ChatListGroup, number>(), chatDateGroupByKey: byKey };
    const now = new Date();
    for (const thread of activeThreads) {
      byKey.set(
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        chatListGroupOf(thread, now),
      );
    }
    return {
      chatDateGroupCounts: countChatListGroups(activeThreads, now),
      chatDateGroupByKey: byKey,
    };
  }, [activeThreads, nowMinute, sidebarMode]);

  const visibleWorkingThreads = useMemo(() => {
    if (workingShelfExpanded) return workingThreads;
    if (routeThreadKey === null) return EMPTY_THREADS;
    const routeThread = workingThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    );
    return routeThread === undefined ? EMPTY_THREADS : [routeThread];
  }, [routeThreadKey, workingShelfExpanded, workingThreads]);

  const orderedThreads = useMemo(
    () => [
      ...renderedActiveThreads,
      ...visibleWorkingThreads,
      ...visibleSnoozedThreads,
      ...renderedSettledThreads,
    ],
    [renderedActiveThreads, visibleWorkingThreads, visibleSnoozedThreads, renderedSettledThreads],
  );
  const orderedThreadKeys = useMemo(
    () =>
      orderedThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    [orderedThreads],
  );
  // Rows call back into the click handler without carrying the ordered list as
  // a prop — a fresh array identity per shell update would defeat every row's
  // memoization. The ref keeps shift-range-select working against the list as
  // rendered at click time.
  const orderedThreadKeysRef = useRef(orderedThreadKeys);
  orderedThreadKeysRef.current = orderedThreadKeys;
  const threadByKey = useMemo(
    () =>
      new Map(
        orderedThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [orderedThreads],
  );
  // Handlers read these through refs: depending on per-update Map/Set
  // identities would give every row a fresh callback prop on each shell
  // event and defeat row memoization during streaming.
  const threadByKeyRef = useRef(threadByKey);
  threadByKeyRef.current = threadByKey;
  // handleNewThread is inherently unstable (depends on the projects list);
  // a ref keeps it out of attemptSettle's dependency array.
  const handleNewThreadRef = useRef(newThreadContext.handleNewThread);
  handleNewThreadRef.current = newThreadContext.handleNewThread;
  const settledThreadKeys = useMemo(
    () =>
      new Set(
        settledThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
    [settledThreads],
  );
  const settledThreadKeysRef = useRef(settledThreadKeys);
  settledThreadKeysRef.current = settledThreadKeys;
  const snoozedThreadKeys = useMemo(
    () =>
      new Set(
        snoozedThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
    [snoozedThreads],
  );
  const snoozedThreadKeysRef = useRef(snoozedThreadKeys);
  snoozedThreadKeysRef.current = snoozedThreadKeys;

  const jumpLabelByKey = useMemo(() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand);
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  }, [keybindings, orderedThreadKeys]);
  const { showThreadJumpHints: showJumpHints, updateThreadJumpHintsVisibility } =
    useThreadJumpHintVisibility();

  // Settled threads are live shells, so opening one is plain navigation:
  // history stays readable without un-settling, and sending a message or
  // starting a session un-settles server-side.
  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      return router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor],
  );

  const queuePendingFileDrop = useSidebarPendingFileDropStore((s) => s.queuePendingFileDrop);
  const clearPendingFileDrop = useSidebarPendingFileDropStore((s) => s.clearPendingFileDrop);
  const handleThreadFileDrop = useCallback(
    async (threadRef: ScopedThreadRef, files: File[]) => {
      const dropId = queuePendingFileDrop({ threadRef, files });
      const landedBefore =
        router.buildLocation({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        }).pathname === router.state.location.pathname;
      if (landedBefore) return;

      try {
        await navigateToThread(threadRef);
        const landed =
          router.buildLocation({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
          }).pathname === router.state.location.pathname;
        if (!landed) clearPendingFileDrop(dropId);
      } catch {
        clearPendingFileDrop(dropId);
      }
    },
    [clearPendingFileDrop, navigateToThread, queuePendingFileDrop, router],
  );

  const navigateToDraft = useCallback(
    (draftId: DraftId) => {
      // Unconditional: also drops a stale selection anchor left by
      // plain-click navigation, so a later shift-click starts fresh
      // instead of ranging from a row that is no longer the context.
      // (clearSelection no-ops when there is nothing to clear.)
      clearSelection();
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({ to: "/draft/$draftId", params: { draftId } });
    },
    [clearSelection, isMobile, router, setOpenMobile],
  );

  const clearThreadSearch = useCallback(() => {
    setThreadSearchQuery("");
    setActiveSearchResultIndex(0);
  }, []);
  const selectThreadSearchResult = useCallback(
    (thread: EnvironmentThreadShell) => {
      clearThreadSearch();
      navigateToThread(scopeThreadRef(thread.environmentId, thread.id));
    },
    [clearThreadSearch, navigateToThread],
  );
  const handleThreadSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      // IME composition (Japanese/Chinese input) uses the same keys; committing
      // a candidate must not move the highlight or navigate away mid-compose.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" && isSearchingThreads) {
        event.preventDefault();
        event.stopPropagation();
        clearThreadSearch();
        return;
      }
      if (threadSearchResults.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveSearchResultIndex((index) => (index + 1) % threadSearchResults.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSearchResultIndex(
          (index) => (index - 1 + threadSearchResults.length) % threadSearchResults.length,
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const result = threadSearchResults[activeSearchResultIndex];
        if (result) selectThreadSearchResult(result);
      }
    },
    [
      activeSearchResultIndex,
      clearThreadSearch,
      isSearchingThreads,
      selectThreadSearchResult,
      threadSearchResults,
    ],
  );

  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const startThreadRename = useCallback((threadRef: ScopedThreadRef, title: string) => {
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
    setRenamingThreadKey(scopedThreadKey(threadRef));
    setRenamingTitle(title);
  }, []);
  const cancelThreadRename = useCallback(() => setRenamingThreadKey(null), []);
  const commitThreadRename = useCallback(
    (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
      void (async () => {
        if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
        const trimmed = title.trim();
        setRenamingThreadKey(null);
        if (trimmed.length === 0) {
          toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
          return;
        }
        if (trimmed === originalTitle) return;
        const result = await updateThreadMetadata({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, title: trimmed },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to rename thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [updateThreadMetadata],
  );
  // The rename field's regenerate button and the row menu's Regenerate Title:
  // drop the typed title and let the agent name the thread again.
  const regenerateThreadTitle = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        setRenamingThreadKey(null);
        if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
        const result = await updateThreadMetadata({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, regenerateTitle: true },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to regenerate thread title",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [updateThreadMetadata],
  );

  const handleThreadClick = useCallback(
    (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
      if (isSidebarNestedLinkClick(event.target)) return;
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const threadKey = scopedThreadKey(threadRef);
      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadKey);
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        rangeSelectTo(threadKey, drawnThreadKeysRef.current);
        return;
      }
      if (isTrailingDoubleClick(event.detail)) {
        return;
      }
      navigateToThread(threadRef);
    },
    [navigateToThread, rangeSelectTo, toggleThreadSelection],
  );

  // A settle per thread at a time: double clicks and repeated menu picks
  // must not dispatch a second settle that fails and toasts a false error.
  const settlingThreadKeysRef = useRef(new Set<string>());
  // Parking the thread you're looking at (settle or snooze) moves you
  // forward: the next remaining card (never a settled or snoozed row, never
  // one leaving in the same batch), or a fresh draft in this project when it
  // was the last active one. Callers snapshot the plan BEFORE the command
  // mutates the partition; background parks never navigate (null plan).
  const planForwardNavigation = useCallback(
    (threadKey: string, coParkingKeys?: ReadonlySet<string>): (() => void) | null => {
      if (routeThreadKeyRef.current !== threadKey) return null;
      const shell = threadByKeyRef.current.get(threadKey);
      const orderedKeys = orderedThreadKeysRef.current;
      const settledKeys = settledThreadKeysRef.current;
      const snoozedKeys = snoozedThreadKeysRef.current;
      const currentIndex = orderedKeys.indexOf(threadKey);
      const nextCardKey =
        currentIndex === -1
          ? null
          : ([...orderedKeys.slice(currentIndex + 1), ...orderedKeys.slice(0, currentIndex)].find(
              (key) => !settledKeys.has(key) && !snoozedKeys.has(key) && !coParkingKeys?.has(key),
            ) ?? null);
      const nextThread = nextCardKey ? threadByKeyRef.current.get(nextCardKey) : null;
      return nextThread
        ? () => navigateToThread(scopeThreadRef(nextThread.environmentId, nextThread.id))
        : shell
          ? () =>
              void handleNewThreadRef.current(scopeProjectRef(shell.environmentId, shell.projectId))
          : () => void router.navigate({ to: "/" });
    },
    [navigateToThread, router],
  );

  const attemptSettle = useCallback(
    (threadRef: ScopedThreadRef, opts: { coSettlingKeys?: ReadonlySet<string> } = {}) => {
      void (async () => {
        const threadKey = scopedThreadKey(threadRef);
        if (settlingThreadKeysRef.current.has(threadKey)) return;
        settlingThreadKeysRef.current.add(threadKey);
        try {
          const navigateAfterSettle = planForwardNavigation(threadKey, opts.coSettlingKeys);
          const result = await settleThread(threadRef);
          if (result._tag === "Failure") {
            // Never navigate away from a thread that did not settle.
            if (!isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to settle thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          // Only move forward if the user is still on the settled thread —
          // a navigation made during the await wins over ours.
          if (
            shouldNavigateAfterThreadPark({
              threadKey,
              currentThreadKey: routeThreadKeyRef.current,
              action: "settle",
              now: new Date().toISOString(),
              thread: readThreadShell(threadRef),
            })
          ) {
            navigateAfterSettle?.();
          }
        } finally {
          settlingThreadKeysRef.current.delete(threadKey);
        }
      })();
    },
    [planForwardNavigation, settleThread],
  );
  // The thread.settle shortcut parks the open thread through this same path.
  useEffect(() => registerSettleAndAdvance(attemptSettle), [attemptSettle]);
  // Post-settle navigation must skip threads settling in this same batch —
  // they are all leaving the card block together. Rows that are already
  // explicitly settled are skipped: nothing to do on a valid mixed selection.
  const settleThreads = useCallback(
    (threadKeys: readonly string[]) => {
      const coSettlingKeys = new Set(threadKeys);
      for (const threadKey of threadKeys) {
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread || thread.settledOverride === "settled") continue;
        attemptSettle(scopeThreadRef(thread.environmentId, thread.id), { coSettlingKeys });
      }
    },
    [attemptSettle],
  );
  const attemptUnsettle = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await unsettleThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to un-settle thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [unsettleThread],
  );
  const attemptUnsnooze = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await unsnoozeThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to wake thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [unsnoozeThread],
  );
  const threadListRef = useRef<HTMLUListElement | null>(null);
  const listMotionRef = useRef<ReturnType<typeof createSidebarListMotion> | null>(null);
  const remeasureFrameRef = useRef<number | null>(null);
  const attachListMotionRef = useCallback((node: HTMLUListElement | null) => {
    threadListRef.current = node;
    listMotionRef.current?.dispose();
    listMotionRef.current = node === null ? null : createSidebarListMotion(node);
    listMotionRef.current?.update(false);
    if (node === null && remeasureFrameRef.current !== null) {
      cancelAnimationFrame(remeasureFrameRef.current);
      remeasureFrameRef.current = null;
    }
  }, []);
  // Folding moves rows by their own height motion, not the list's: once a
  // fold settles, the list motion takes the rows' new places as its start.
  // Every row of a fold ends together, so one read per frame covers them.
  const handleListTransitionEnd = useCallback((event: ReactTransitionEvent<HTMLUListElement>) => {
    if (event.propertyName !== "grid-template-rows" || remeasureFrameRef.current !== null) return;
    remeasureFrameRef.current = requestAnimationFrame(() => {
      remeasureFrameRef.current = null;
      listMotionRef.current?.remeasure();
    });
  }, []);

  // One pointer gesture at a time: a row press that leaves the list drags
  // the thread into a composer as context, and an action-button press sweeps
  // its action across neighboring rows. Pinned chats reorder on the same
  // gesture; Work's cards reorder through dnd-kit (SidebarSortSensor).
  const dragSensorRef = useRef<SidebarPointerSensor | null>(null);
  const contextDragKeyRef = useRef<string | null>(null);
  const cancelThreadDrag = useCallback(() => {
    dragSensorRef.current?.cancel();
  }, []);
  // Dragged threads: the multi-selection when the picked-up row is part of it.
  const contextDragThreads = useCallback((): ReadonlyArray<ScopedThreadRef> => {
    const key = contextDragKeyRef.current;
    if (key === null) return [];
    const selected = useThreadSelectionStore.getState().selectedThreadKeys;
    const keys = selected.has(key) ? [...selected] : [key];
    return keys.flatMap((candidate) => {
      const ref = parseScopedThreadKey(candidate);
      return ref ? [ref] : [];
    });
  }, []);
  const pointerOutsideThreadList = useCallback((point: { x: number; y: number }) => {
    const bounds = threadListRef.current?.getBoundingClientRect();
    return bounds !== undefined && (point.x < bounds.left || point.x > bounds.right);
  }, []);
  const moveThreadContextDrag = useCallback(
    (point: { x: number; y: number }) => {
      if (!pointerOutsideThreadList(point)) {
        endThreadContextDrag();
        return false;
      }
      const threads = contextDragThreads();
      const title =
        threadByKeyRef.current.get(contextDragKeyRef.current ?? "")?.title.trim() || "Thread";
      moveThreadContextDragGhost(point, { title, count: threads.length });
      return true;
    },
    [contextDragThreads, pointerOutsideThreadList],
  );
  const dropThreadContextDrag = useCallback(
    (point: { x: number; y: number }) => {
      if (!pointerOutsideThreadList(point)) return false;
      dropThreadContext(point, contextDragThreads());
      return true;
    },
    [contextDragThreads, pointerOutsideThreadList],
  );
  /** Pinned chat keys in list order, when `key` is a pinned chat that can be dragged to reorder. */
  const pinnedReorderOrder = (key: string): string[] | null => {
    if (sidebarMode !== "chats") return null;
    const thread = threadByKeyRef.current.get(key);
    if (
      thread?.pinnedAt == null ||
      serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinReorder !== true ||
      !readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)
    ) {
      return null;
    }
    const order = activeThreads
      .filter((candidate) => candidate.pinnedAt != null)
      .map((candidate) => scopedThreadKey(scopeThreadRef(candidate.environmentId, candidate.id)));
    return order.length > 1 ? order : null;
  };
  const commitPinDrag = (key: string, order: readonly string[]) => {
    const keysById = new Map(
      order.map((id) => [id, threadByKeyRef.current.get(id)?.pinOrderKey ?? null]),
    );
    const writes = planPinnedReorder({ orderedIds: order, keysById, movedId: key });
    if (writes.length === 0) {
      setPinDrag(null);
      return;
    }
    // The preview holds until the writes land, so the row never jumps back.
    void Promise.all(
      writes.flatMap(({ id, orderKey }) => {
        const ref = parseScopedThreadKey(id);
        return ref ? [reorderPinnedThread(ref, orderKey)] : [];
      }),
    ).then((results) => {
      setPinDrag((current) => (current?.key === key ? null : current));
      for (const result of results) {
        if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) continue;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to reorder pinned threads",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
    });
  };
  // Work cards reorder when their server keeps a manual active order and this
  // client may operate threads there. Pinned threads keep the pinned order.
  const canReorderWorkIn = useCallback(
    (environmentId: EnvironmentId) =>
      serverConfigs.get(environmentId)?.environment.capabilities.threadActiveReorder === true &&
      readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
    [serverConfigs],
  );
  /** Every reorderable Work card as drawn, across groups: the order keys are planned in. */
  const workReorderFullOrder = (): string[] =>
    (workRowsRef.current?.threads ?? []).flatMap(({ key: candidate }) => {
      const thread = threadByKeyRef.current.get(candidate);
      return thread && thread.pinnedAt == null && canReorderWorkIn(thread.environmentId)
        ? [candidate]
        : [];
    });
  /** The sortable cards of `key`'s project group as drawn, when it can move in one. */
  const workGroupOrderOf = (key: string): readonly string[] | null => {
    const groupKey = workSortRef.current.groupOf.get(key);
    return groupKey === undefined ? null : (workSortRef.current.orders.get(groupKey) ?? null);
  };
  const [workReorderAnnouncement, setWorkReorderAnnouncement] = useState("");
  // A sort drop draws the new order where dnd-kit already glides the card, so
  // the list motion sits that update out rather than move the card twice.
  const listMotionSkipRef = useRef(false);
  /** Moves `key` to its place in `groupOrder` (its group's new order) and saves it. */
  const commitWorkGroupReorder = (
    key: string,
    groupOrder: readonly string[],
    options: { readonly sortDrop: boolean },
  ) => {
    const order = placeInGroupOrder(workReorderFullOrder(), groupOrder, key);
    const keysById = new Map(
      [...threadByKeyRef.current].map(([id, thread]) => [id, thread.activeOrderKey ?? null]),
    );
    const writes = planWorkCardReorder({ drawnOrder: order, keysById, movedId: key });
    if (writes.length === 0) {
      setWorkDrag(null);
      return;
    }
    if (options.sortDrop) listMotionSkipRef.current = true;
    // The preview holds until the writes land, so the card never jumps back.
    setWorkDrag({ key, order });
    void Promise.all(
      writes.flatMap(({ id, orderKey }) => {
        const ref = parseScopedThreadKey(id);
        return ref ? [reorderActiveThread(ref, orderKey)] : [];
      }),
    ).then((results) => {
      const failed = results.some(
        (result) => result._tag === "Failure" && !isAtomCommandInterrupted(result),
      );
      // A failed move falls back to the saved order. A saved one holds its
      // preview until the list's own order catches up (see workDropLanded):
      // a command can land before its rows do, and dropping the preview then
      // would swing the cards back and forth.
      setWorkDrag((current) =>
        current?.key !== key ? current : failed ? null : { ...current, settled: true },
      );
      for (const result of results) {
        if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) continue;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to reorder Work",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
    });
  };
  /** alt+ArrowUp / alt+ArrowDown on a focused Working card moves it one place in its project. */
  const handleWorkListKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const key = (event.target as HTMLElement).closest<HTMLElement>("[data-thread-item]")?.dataset
      .threadItem;
    if (key === undefined) return;
    const groupOrder = workGroupOrderOf(key);
    if (groupOrder === null) return;
    event.preventDefault();
    const next = moveInOrder(groupOrder, key, event.key === "ArrowUp" ? -1 : 1);
    if (next === null) return;
    const position = next.indexOf(key) + 1;
    setWorkReorderAnnouncement(
      `${threadByKeyRef.current.get(key)?.title ?? "Work"} moved to ${position} of ${next.length}`,
    );
    commitWorkGroupReorder(key, next, { sortDrop: false });
    // Moving a row can drop focus from it; keep it on the card that moved.
    const focused = event.target as HTMLElement;
    requestAnimationFrame(() => {
      if (focused.isConnected && document.activeElement !== focused) focused.focus();
    });
  };
  const startThreadContextDrag = useStableCallback(
    (threadRef: ScopedThreadRef, event: PointerEvent) => {
      if (dragSensorRef.current !== null) return;
      const key = scopedThreadKey(threadRef);
      // A sortable Work card's press belongs to its slot's dnd-kit sensor,
      // which handles the drag out of the list too.
      if (workSortRef.current.groupOf.has(key)) return;
      // A pinned chat drags within Pinned to reorder it. Positions are read
      // once at the start, against the list, so the preview's own motion and
      // scrolling never feed back into the drop slot.
      const pinOrder = pinnedReorderOrder(key);
      let pinStart: { pointerY: number; center: number; midpoints: number[] } | null = null;
      let pinPreview: readonly string[] | null = null;
      const listY = (y: number) => y - (threadListRef.current?.getBoundingClientRect().top ?? 0);
      dragSensorRef.current = new SidebarPointerSensor({
        active: key,
        event,
        options: {
          distance: SIDEBAR_DRAG_DISTANCE,
          onAttach: () => {},
          onFinish: () => {
            dragSensorRef.current = null;
            contextDragKeyRef.current = null;
            endThreadContextDrag();
          },
          onMove: moveThreadContextDrag,
          onDrop: dropThreadContextDrag,
        },
        onPending: () => {},
        onStart: ({ y }) => {
          contextDragKeyRef.current = key;
          const list = threadListRef.current;
          if (pinOrder === null || list === null) return;
          const layout = new Map<string, { top: number; height: number }>();
          // Rows sit in their fold slots; offsets still measure from the list.
          for (const row of list.querySelectorAll<HTMLElement>("[data-thread-item]")) {
            layout.set(row.dataset.threadItem!, { top: row.offsetTop, height: row.offsetHeight });
          }
          const moved = layout.get(key);
          if (moved === undefined) return;
          pinStart = {
            pointerY: listY(y),
            center: moved.top + moved.height / 2,
            midpoints: pinOrder.flatMap((candidate) => {
              const row = candidate === key ? undefined : layout.get(candidate);
              return row ? [row.top + row.height / 2] : [];
            }),
          };
        },
        onMove: ({ y }) => {
          if (pinOrder === null || pinStart === null) return;
          const next = pinnedDragOrder(
            pinOrder,
            key,
            pinStart.midpoints,
            pinStart.center + listY(y) - pinStart.pointerY,
          );
          if (pinPreview !== null && next.join("\0") === pinPreview.join("\0")) return;
          pinPreview = next;
          setPinDrag({ key, order: next });
        },
        onEnd: () => {
          if (pinPreview === null) return;
          if (pinPreview.join("\0") === pinOrder?.join("\0")) setPinDrag(null);
          else commitPinDrag(key, pinPreview);
        },
        onCancel: () => {
          if (pinPreview !== null) setPinDrag(null);
        },
        onAbort: () => {},
      });
    },
  );
  const sectionByThreadKey = useMemo(() => {
    const map = new Map<string, SidebarSection>();
    const add = (list: readonly EnvironmentThreadShell[], section: SidebarSection) => {
      for (const thread of list) {
        map.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), section);
      }
    };
    add(activeThreads, "active");
    add(workingThreads, "working");
    add(snoozedThreads, "snoozed");
    add(settledThreads, "settled");
    return map;
  }, [activeThreads, settledThreads, snoozedThreads, workingThreads]);
  const sectionByThreadKeyRef = useRef(sectionByThreadKey);
  sectionByThreadKeyRef.current = sectionByThreadKey;
  // Drag a row action to apply it to the armed rows in the same section.
  // Staying in one section keeps an overshoot from changing neighboring
  // sections, whose boundaries may be hidden outside a row drag. The sweep
  // runs on the row drag's sensor and ref, so unmounting the list cancels it.
  const [actionSweep, setActionSweep] = useState<{
    action: SidebarSweepAction;
    keys: ReadonlySet<string>;
  } | null>(null);
  const startActionSweep = useStableCallback(
    (threadRef: ScopedThreadRef, action: SidebarSweepAction, event: PointerEvent) => {
      const originKey = scopedThreadKey(threadRef);
      const originSection = sectionByThreadKeyRef.current.get(originKey);
      const canApply = (key: string) => {
        const thread = threadByKeyRef.current.get(key);
        const capabilities =
          thread && serverConfigs.get(thread.environmentId)?.environment.capabilities;
        return (
          thread !== undefined &&
          sectionByThreadKeyRef.current.get(key) === originSection &&
          (action === "unsnooze"
            ? capabilities?.threadSnooze === true
            : capabilities?.threadSettlement === true)
        );
      };
      let targetKey: string | null = null;
      let sweptKeys: string[] = [];
      const sweepTo = (key: string | null) => {
        if (key === null || key === targetKey) return;
        targetKey = key;
        sweptKeys = resolveSidebarSweepKeys(drawnThreadKeysRef.current, originKey, key, canApply);
        setActionSweep({ action, keys: new Set(sweptKeys) });
      };
      dragSensorRef.current = new SidebarPointerSensor({
        active: originKey,
        event,
        options: {
          distance: SIDEBAR_DRAG_DISTANCE,
          onAttach: () => {},
          onFinish: () => {
            dragSensorRef.current = null;
            setActionSweep(null);
          },
        },
        onPending: () => {},
        onStart: () => sweepTo(originKey),
        onMove: ({ y }) =>
          sweepTo(threadListRef.current && sidebarThreadKeyAtY(threadListRef.current, y)),
        // Also runs after a press that never moved. Nothing is swept then,
        // and the button's own click applies its action. Rows that changed
        // section mid-gesture, say settled from another device, are skipped.
        onEnd: () => {
          const keys = sweptKeys.filter(canApply);
          if (action === "settle") {
            settleThreads(keys);
            return;
          }
          for (const key of keys) {
            const ref = parseScopedThreadKey(key);
            if (ref === null) continue;
            if (action === "unsettle") attemptUnsettle(ref);
            else attemptUnsnooze(ref);
          }
        },
        onCancel: () => {},
        onAbort: () => {},
      });
    },
  );
  const sidebarListItems = useMemo((): readonly SidebarListItem[] => {
    const rowsOf = (
      list: readonly EnvironmentThreadShell[],
      section: SidebarSection,
    ): SidebarListItem[] =>
      list.map((thread) => {
        const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        return { kind: "thread", key, section };
      });
    if (
      activeThreads.length +
        workingThreads.length +
        snoozedThreads.length +
        settledThreads.length ===
      0
    ) {
      return [];
    }
    const items: SidebarListItem[] = rowsOf(renderedActiveThreads, "active");
    if (sidebarMode === "chats") return items;
    if (workingThreads.length > 0) {
      items.push({ kind: "marker", marker: "working-header" });
      items.push(...rowsOf(visibleWorkingThreads, "working"));
    }
    if (snoozedThreads.length > 0) {
      items.push({ kind: "marker", marker: "snoozed-header" });
      items.push(...rowsOf(visibleSnoozedThreads, "snoozed"));
    }
    items.push({ kind: "marker", marker: "settled-header" });
    items.push(...rowsOf(renderedSettledThreads, "settled"));
    return items;
  }, [
    activeThreads.length,
    renderedActiveThreads,
    renderedSettledThreads,
    sidebarMode,
    settledThreads.length,
    snoozedThreads.length,
    visibleSnoozedThreads,
    visibleWorkingThreads,
    workingThreads.length,
  ]);
  // A project picked in the Work hero rides on a draft until its first send,
  // and files the draft's card under that project.
  const pendingFolderByThreadId = usePendingProjectFolderStore((state) => state.byThreadId);
  // Work's cards as drawn, top to bottom: the filter's threads in reverse of
  // their order (new work lowest, by the dock), then the unsent drafts, newest
  // lowest. While a card is saving a move the list previews the new order.
  // `groups` files them under project headings, each keeping that order.
  const workRows = useMemo(() => {
    if (sidebarMode !== "tasks") return null;
    const shown = openShelf ?? "active";
    // Only live work sits under project headings. Snoozed and Settled are
    // shelves of put-away threads, one flat list each (each card names its
    // project), drawn below like the other modes' shelves.
    if (shown === "snoozed" || shown === "settled") return null;
    const threads: { key: string; section: SidebarSection }[] = [];
    for (const item of sidebarListItems) {
      if (item.kind !== "thread") continue;
      if (shown === "attention") {
        if (item.section !== "active" || !attentionThreadKeys.has(item.key)) continue;
      } else if (item.section !== shown) {
        continue;
      }
      threads.push({ key: item.key, section: item.section });
    }
    threads.reverse();
    const savedOrder = threads.map((entry) => entry.key);
    const drawnOrder =
      workDrag !== null && shown === "active"
        ? applyDrawnOrder(savedOrder, workDrag.order)
        : savedOrder;
    const byKey = new Map(threads.map((entry) => [entry.key, entry]));
    const previewed =
      drawnOrder === savedOrder ? threads : drawnOrder.map((key) => byKey.get(key)!);
    // The saved order now draws what the preview does.
    const dropLanded = drawnOrder.every((key, index) => savedOrder[index] === key);
    const drafts =
      shown === "active" ? workDrafts.toSorted((a, b) => a.createdAtMs - b.createdAtMs) : [];
    // One stable folder per project (rowFolderByKey), for the heading's mark.
    const projectOf = (entry: EnvironmentProjectLabel | null | undefined) =>
      entry
        ? {
            key: entry.key,
            name: entry.label.name,
            folder: rowFolderByKey.get(entry.key) ?? null,
          }
        : null;
    const cards: WorkCardEntry[] = [
      ...previewed.map((entry) => ({ kind: "thread" as const, ...entry })),
      ...drafts.map((draft) => ({ kind: "draft" as const, key: `draft:${draft.draftId}`, draft })),
    ];
    const groups = groupWorkCards(cards, (card) => {
      if (card.kind === "thread") {
        const thread = threadByKey.get(card.key);
        return projectOf(thread && workThreadFolder(thread, projectLabelDirectory));
      }
      const { draft } = card;
      const picked = pendingFolderByThreadId[draft.threadId];
      return projectOf(
        picked?.environmentId === draft.environmentId
          ? projectLabelDirectory.byKey.get(projectLabelKey(draft.environmentId, picked.folderId))
          : projectLabelDirectory.folderByRepository.get(
              scopedRepositoryKey(draft.environmentId, draft.projectId),
            ),
      );
    });
    return { shown, threads: previewed, groups, dropLanded };
  }, [
    attentionThreadKeys,
    openShelf,
    pendingFolderByThreadId,
    projectLabelDirectory,
    rowFolderByKey,
    sidebarListItems,
    sidebarMode,
    threadByKey,
    workDrafts,
    workDrag,
  ]);
  const workRowsRef = useRef(workRows);
  workRowsRef.current = workRows;
  // A saved move lets go of its preview once the rows draw the same order,
  // so nothing moves. If they never do (another device moved them too), it
  // lets go after a while and the list snaps to the saved order.
  const workDropLanded = workRows?.dropLanded ?? true;
  useEffect(() => {
    if (workDrag?.settled !== true) return;
    const key = workDrag.key;
    const release = () => setWorkDrag((current) => (current?.key === key ? null : current));
    if (workDropLanded) {
      release();
      return;
    }
    const timer = window.setTimeout(() => {
      listMotionSkipRef.current = true;
      release();
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [workDrag, workDropLanded]);
  // Rows as they read on screen, for range selection and action sweeps: in
  // Work that is project by project. Settle-and-advance keeps the list order.
  const drawnThreadKeysRef = useRef<readonly string[]>(orderedThreadKeys);
  drawnThreadKeysRef.current =
    workRows === null
      ? orderedThreadKeys
      : workRows.groups.flatMap((group) =>
          group.cards.flatMap((card) => (card.kind === "thread" ? [card.key] : [])),
        );
  const workRowsOrderKey =
    workRows?.groups.flatMap((group) => group.cards.map((card) => card.key)).join("\0") ?? "";
  // Which Work cards can be dragged, and within which group: the open list's
  // cards on servers that keep a manual order (pinned ones keep theirs), as
  // drawn, in groups that show at least two of them.
  const workSort = useMemo(() => {
    const groupOf = new Map<string, string>();
    const orders = new Map<string, string[]>();
    if (workRows === null || workRows.shown !== "active") return { groupOf, orders };
    for (const group of workRows.groups) {
      const collapsed = collapsedInSpace.includes(workGroupSectionKey(group.key));
      const keys = group.cards.flatMap((card) => {
        if (card.kind !== "thread" || (collapsed && card.key !== routeThreadKey)) return [];
        const thread = threadByKey.get(card.key);
        const movable =
          thread !== undefined && thread.pinnedAt == null && canReorderWorkIn(thread.environmentId);
        return movable ? [card.key] : [];
      });
      if (keys.length < 2) continue;
      orders.set(group.key, keys);
      for (const key of keys) groupOf.set(key, group.key);
    }
    return { groupOf, orders };
  }, [canReorderWorkIn, collapsedInSpace, routeThreadKey, threadByKey, workRows]);
  const workSortRef = useRef(workSort);
  workSortRef.current = workSort;
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const workSortSensorOptions = useMemo(
    (): SidebarSortSensorOptions => ({
      distance: SIDEBAR_DRAG_DISTANCE,
      canActivate: () => dragSensorRef.current === null,
      onAttach: (sensor) => {
        dragSensorRef.current = sensor;
      },
      onFinish: () => {
        dragSensorRef.current = null;
        contextDragKeyRef.current = null;
        endThreadContextDrag();
      },
      onMove: moveThreadContextDrag,
      onDrop: dropThreadContextDrag,
    }),
    [dropThreadContextDrag, moveThreadContextDrag],
  );
  const workSortSensors = useSensors(useSensor(SidebarSortSensor, workSortSensorOptions));
  // A card only ever lands among its own group's cards.
  const workSortCollision = useMemo(
    () => sidebarGroupCollision((id) => workSortRef.current.groupOf.get(id)),
    [],
  );
  const describeWorkSortItem = useCallback(
    (id: UniqueIdentifier) => threadByKeyRef.current.get(String(id))?.title ?? "Work",
    [],
  );
  const handleWorkSortStart = useCallback(({ active }: DragStartEvent) => {
    // A drag that leaves the list carries this thread into a composer.
    contextDragKeyRef.current = String(active.id);
  }, []);
  const handleWorkSortEnd = ({ active, over }: DragEndEvent) => {
    const key = String(active.id);
    const groupOrder = workGroupOrderOf(key);
    if (over === null || groupOrder === null) return;
    const from = groupOrder.indexOf(key);
    const to = groupOrder.indexOf(String(over.id));
    if (from === -1 || to === -1 || from === to) return;
    commitWorkGroupReorder(key, arrayMove([...groupOrder], from, to), { sortDrop: true });
  };
  // Every shell event rebuilds sidebarListItems, but rows only move when the
  // rendered order or a row's section changes. Keying the motion pass on that
  // keeps ordinary updates from forcing a layout read and animating rows
  // whose position drifted for other reasons.
  const sidebarListOrderKey = useMemo(
    () =>
      sidebarListItems
        .map((item) => (item.kind === "thread" ? `${item.key}:${item.section}` : item.marker))
        .join("\0"),
    [sidebarListItems],
  );
  const sidebarListHasRows = sidebarListItems.length + visibleDraftSessionCount > 0;
  const sidebarModeListRef = useRef<HTMLDivElement | null>(null);
  // Each list (a mode and its filter, or search) keeps its own place. Active
  // lists fill from the bottom, against the dock; Chats, search and the
  // put-away shelves (Settled newest first, Snoozed soonest wake first) run
  // from the top.
  const agentListFilter = useAgentListFilter();
  useSidebarListAnchor(
    sidebarModeListRef,
    isSearchingThreads
      ? "search"
      : sidebarMode === "tasks"
        ? `tasks:${openShelf ?? "active"}`
        : sidebarMode === "agents"
          ? `agents:${agentListFilter}`
          : sidebarMode,
    sidebarListEdge({ searching: isSearchingThreads, mode: sidebarMode, shelf: openShelf ?? null }),
  );
  const listMotionModeRef = useRef(sidebarMode);
  const listMotionShelfRef = useRef(openShelf);
  const listMotionRevealRef = useRef({ chats: chatVisibleCount, settled: settledVisibleCount });
  const listMotionCollapsedRef = useRef(collapsedInSpace);
  useLayoutEffect(() => {
    // Draft navigation can reveal a frozen row without changing the draft count.
    void sidebarListOrderKey;
    // A move's preview reorders rows without changing the items.
    void workRowsOrderKey;
    // A fold animates its rows' own height (SidebarFoldRow); the list motion
    // only takes note of where everything is.
    const folded = listMotionCollapsedRef.current !== collapsedInSpace;
    listMotionCollapsedRef.current = collapsedInSpace;
    const sortDropped = listMotionSkipRef.current;
    listMotionSkipRef.current = false;
    // A mode switch replaces the whole list. Fading every row out (each as a
    // deep clone) and back in cost a long frame, so the list snaps to the new
    // mode; AppSidebarLayout plays the switch's one enter motion on the column.
    const modeChanged = listMotionModeRef.current !== sidebarMode;
    listMotionModeRef.current = sidebarMode;
    // Switching the Work count bar's filter swaps the list the same way:
    // instantly, with no fade.
    const shelfChanged = listMotionShelfRef.current !== openShelf;
    listMotionShelfRef.current = openShelf;
    // A revealed page fades its rows in where they land; nothing travels.
    const revealed =
      chatVisibleCount > listMotionRevealRef.current.chats ||
      settledVisibleCount > listMotionRevealRef.current.settled;
    listMotionRevealRef.current = { chats: chatVisibleCount, settled: settledVisibleCount };
    listMotionRef.current?.update(
      sidebarListHasRows && !modeChanged && !shelfChanged && !folded && !sortDropped,
      { inPlace: revealed },
    );
  }, [
    chatVisibleCount,
    openShelf,
    routeDraftIdForRows,
    settledVisibleCount,
    sidebarListHasRows,
    sidebarListOrderKey,
    sidebarMode,
    visibleDraftSessionCount,
    workRowsOrderKey,
    collapsedInSpace,
  ]);
  // One snooze per thread at a time — same double-dispatch guard as settle.
  const snoozingThreadKeysRef = useRef(new Set<string>());
  const performSnooze = useCallback(
    async (
      threadRef: ScopedThreadRef,
      preset: Pick<SnoozePreset, "snoozedUntil">,
      opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
    ) => {
      const threadKey = scopedThreadKey(threadRef);
      if (snoozingThreadKeysRef.current.has(threadKey)) {
        return { status: "skipped" } as const;
      }
      snoozingThreadKeysRef.current.add(threadKey);
      try {
        // Snoozing the open thread moves you forward, same as settle —
        // both park the thread you're done with for now.
        const navigateAfterSnooze = planForwardNavigation(threadKey, opts.coSnoozingKeys);
        const result = await snoozeThread(threadRef, preset.snoozedUntil);
        if (result._tag === "Failure") {
          // Never navigate away from a thread that did not snooze.
          return isAtomCommandInterrupted(result)
            ? ({ status: "interrupted" } as const)
            : ({ status: "failure", error: squashAtomCommandFailure(result) } as const);
        }
        // Only move forward if the user is still on the snoozed thread —
        // a navigation made during the await wins over ours.
        if (
          shouldNavigateAfterThreadPark({
            threadKey,
            currentThreadKey: routeThreadKeyRef.current,
            action: "snooze",
            now: new Date().toISOString(),
            thread: readThreadShell(threadRef),
          })
        ) {
          navigateAfterSnooze?.();
        }
        return { status: "success" } as const;
      } finally {
        snoozingThreadKeysRef.current.delete(threadKey);
      }
    },
    [planForwardNavigation, snoozeThread],
  );
  const attemptSnooze = useCallback(
    (
      threadRef: ScopedThreadRef,
      preset: Pick<SnoozePreset, "snoozedUntil">,
      opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
    ) => {
      void (async () => {
        const outcome = await performSnooze(threadRef, preset, opts);
        if (outcome.status === "failure") {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to snooze thread",
              description:
                outcome.error instanceof Error ? outcome.error.message : "An error occurred.",
            }),
          );
          return;
        }
      })();
    },
    [performSnooze],
  );

  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const handleMultiSelectContextMenu = useStableCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      // One exact actionable set: keys whose rows are actually rendered
      // right now. Selections can outlive their rows (settled-tail paging,
      // thread deletion elsewhere) and the menu labels must count only what
      // the actions will touch.
      const selectedThreadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      const threadKeys = selectedThreadKeys.filter((threadKey) =>
        threadByKeyRef.current.has(threadKey),
      );
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      // Snooze (N) is offered when every selected thread can actually take
      // it — a mixed selection with blocked-on-you work would half-apply.
      const selectionNow = new Date();
      const selectedThreads = threadKeys.flatMap((threadKey) => {
        const thread = threadByKeyRef.current.get(threadKey);
        return thread ? [thread] : [];
      });
      const settlingThreads = selectedThreads.filter(
        (thread) => thread.settledOverride !== "settled",
      );
      // An action is offered only when every selected thread's kind has it.
      const selectedCapabilities = selectedThreads.map((thread) =>
        threadCapabilities(
          threadKindForSidebarMode(sidebarModeForThread(thread, sidebarModes.classifier)),
        ),
      );
      const everySelected = (allows: (capabilities: ThreadCapabilities) => boolean) =>
        selectedCapabilities.every(allows);
      const offersLifecycle = everySelected((capabilities) => capabilities.settle);
      const canSnoozeSelection =
        everySelected((capabilities) => capabilities.snooze) &&
        selectedThreads.every(
          (thread) =>
            serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze ===
              true && canSnooze(thread, { now: selectionNow.toISOString() }),
        );
      const titleRegenerationThreads = everySelected((capabilities) => capabilities.regenerateTitle)
        ? selectedThreads.filter(
            (thread) =>
              serverConfigs.get(thread.environmentId)?.environment.capabilities
                .threadTitleRegeneration === true,
          )
        : [];
      const offersMarkUnread = everySelected((capabilities) => capabilities.markUnread);
      const offersDelete = everySelected((capabilities) => capabilities.delete !== false);
      const deleteAlwaysConfirms = selectedCapabilities.some(
        (capabilities) => capabilities.delete === "always-confirm",
      );
      const regeneratableTitleThreads = titleRegenerationThreads.filter(
        (thread) => thread.titleRegeneration == null,
      );
      const titleRegenerationMenuItem = buildBulkTitleRegenerationContextMenuItem({
        supportedCount: titleRegenerationThreads.length,
        actionableCount: regeneratableTitleThreads.length,
      });
      const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat);
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            ...(offersLifecycle
              ? [
                  {
                    id: "settle",
                    label: `Settle (${count})`,
                    disabled: settlingThreads.length === 0 || !canOperateThreads(settlingThreads),
                  },
                ]
              : []),
            ...(canSnoozeSelection
              ? [
                  {
                    id: "snooze",
                    label: `Snooze (${count})`,
                    disabled: !canOperateThreads(selectedThreads),
                    children: [
                      ...snoozePresets.map((preset) => ({
                        id: `snooze:${preset.id}`,
                        label: `${preset.label} (${preset.whenLabel})`,
                        disabled: !canOperateThreads(selectedThreads),
                      })),
                      {
                        id: "snooze:custom",
                        label: "Custom…",
                        separatorBefore: true,
                        disabled: !canOperateThreads(selectedThreads),
                      },
                    ],
                  },
                ]
              : []),
            ...(titleRegenerationMenuItem
              ? [
                  {
                    ...titleRegenerationMenuItem,
                    disabled:
                      titleRegenerationMenuItem.disabled ||
                      !canOperateThreads(regeneratableTitleThreads),
                  },
                ]
              : []),
            ...(offersMarkUnread
              ? [{ id: "mark-unread", label: `Mark as Unread (${count})` }]
              : []),
            ...(offersDelete
              ? [
                  {
                    id: "delete",
                    label:
                      confirmThreadDelete || deleteAlwaysConfirms
                        ? `Delete (${count})…`
                        : `Delete (${count})`,
                    destructive: true,
                    disabled: !canOperateThreads(selectedThreads),
                  },
                ]
              : []),
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure" || clicked.value === null) return;
      const actionTargets =
        clicked.value === "regenerate-title"
          ? regeneratableTitleThreads
          : clicked.value === "settle"
            ? settlingThreads.flatMap((thread) => {
                const current = threadByKeyRef.current.get(
                  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                );
                return current && current.settledOverride !== "settled" ? [current] : [];
              })
            : selectedThreads;
      if (clicked.value === "settle" && actionTargets.length === 0) return;
      if (clicked.value !== "mark-unread" && !checkThreadOperations(actionTargets)) return;
      if (clicked.value?.startsWith("snooze:")) {
        const preset =
          clicked.value === "snooze:custom"
            ? await requestCustomSnooze()
            : snoozePresets.find((candidate) => `snooze:${candidate.id}` === clicked.value);
        if (preset) {
          // Post-snooze navigation must skip threads snoozing in this same
          // batch — they are all leaving the card block together.
          const coSnoozingKeys = new Set(threadKeys);
          clearSelection();
          const outcomes = await Promise.all(
            selectedThreads.map(async (thread) => {
              const threadRef = scopeThreadRef(thread.environmentId, thread.id);
              const outcome = await performSnooze(threadRef, preset, { coSnoozingKeys });
              return { outcome, threadRef };
            }),
          );
          const snoozedThreadRefs = outcomes.flatMap(({ outcome, threadRef }) =>
            outcome.status === "success" ? [threadRef] : [],
          );
          const failures = outcomes.flatMap(({ outcome }) =>
            outcome.status === "failure" ? [outcome.error] : [],
          );

          if (failures.length > 0) {
            const firstError = failures[0];
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title:
                  snoozedThreadRefs.length > 0
                    ? `Failed to snooze ${failures.length} thread${failures.length === 1 ? "" : "s"}`
                    : "Failed to snooze threads",
                description:
                  firstError instanceof Error ? firstError.message : "An error occurred.",
              }),
            );
          }
        }
        return;
      }
      if (clicked.value === "regenerate-title") {
        for (const thread of regeneratableTitleThreads) {
          const result = await updateThreadMetadata({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, regenerateTitle: true },
          });
          if (result._tag === "Success") continue;
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to regenerate thread titles",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        clearSelection();
        return;
      }
      if (clicked.value === "settle") {
        settleThreads(
          actionTargets.map((thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          ),
        );
        clearSelection();
        return;
      }
      if (clicked.value === "mark-unread") {
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          if (thread) markThreadUnread(scopeThreadRef(thread.environmentId, thread.id));
        }
        clearSelection();
        return;
      }
      if (clicked.value !== "delete" || !offersDelete) return;
      if (confirmThreadDelete || deleteAlwaysConfirms) {
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete ${count} thread${count === 1 ? "" : "s"}?`,
              "This permanently clears conversation history for these threads.",
            ].join("\n"),
            { variant: "destructive" },
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      if (
        !checkThreadOperations(
          threadKeys.flatMap((threadKey) => {
            const thread = threadByKeyRef.current.get(threadKey);
            return thread ? [thread] : [];
          }),
        )
      )
        return;
      const { deletedThreadKeys, firstFailure } = await deleteSelectedThreadEntries({
        entries: threadKeys.map((threadKey) => ({ threadKey })),
        delete: async ({ threadKey }, deletedThreadKeys) => {
          const thread = threadByKeyRef.current.get(threadKey);
          if (!thread) return null;
          return deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
            deletedThreadKeys,
          });
        },
      });
      if (firstFailure !== null) {
        const firstError = squashAtomCommandFailure(firstFailure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete threads",
            description: firstError instanceof Error ? firstError.message : "An error occurred.",
          }),
        );
      }
      removeFromSelection(
        getThreadKeysToDeselectAfterDelete(selectedThreadKeys, deletedThreadKeys, (threadKey) => {
          const threadRef = parseScopedThreadKey(threadKey);
          return threadRef !== null && readThreadShell(threadRef) !== null;
        }),
      );
    },
  );

  const handleDraftContextMenu = useStableCallback(
    (draftId: DraftId, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        const session = useComposerDraftStore.getState().getDraftSession(draftId);
        if (!api || !session || session.promotedTo) return;
        const workspacePath =
          session.worktreePath ??
          projectByKey.get(`${session.environmentId}:${session.projectId}`)?.workspaceRoot;
        // A chat draft has no repository to copy from or configure.
        const draftCapabilities = threadCapabilities(
          threadKindForSidebarMode(
            classifySidebarThreadMode({
              isAgent: false,
              isScratch: sidebarModes.classifier.scratchProjectKeys.has(
                `${session.environmentId}:${session.projectId}`,
              ),
              surface: session.surface,
            }),
          ),
        );
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildDraftActionMenuItems({
              hasPath: draftCapabilities.copyWorkspace && Boolean(workspacePath),
              hasBranch: draftCapabilities.copyWorkspace && Boolean(session.branch),
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "copy-path":
            if (workspacePath) copyPathToClipboard(workspacePath, { path: workspacePath });
            return;
          case "copy-branch":
            if (session.branch) copyBranchToClipboard(session.branch, { branch: session.branch });
            return;
          case "discard": {
            // The menu can stay open while the draft sends; discarding a
            // promoting draft would strand the send.
            const current = useComposerDraftStore.getState().getDraftSession(draftId);
            if (current && !current.promotedTo) discardComposerDraft(draftId);
            return;
          }
        }
      })();
    },
  );

  const togglePin = useStableCallback((threadRef: ScopedThreadRef, pinned: boolean) => {
    void (pinned ? unpinThread(threadRef) : pinThread(threadRef)).then((result) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: pinned ? "Failed to unpin thread" : "Failed to pin thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  });
  const handleThreadContextMenu = useStableCallback(
    (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const threadKey = scopedThreadKey(threadRef);
        const selectionState = useThreadSelectionStore.getState();
        if (selectionState.hasSelection() && selectionState.selectedThreadKeys.has(threadKey)) {
          await handleMultiSelectContextMenu(position);
          return;
        }
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) return;
        const threadWorkspacePath =
          thread.worktreePath ??
          projectByKey.get(`${thread.environmentId}:${thread.projectId}`)?.workspaceRoot ??
          null;
        // The thread's kind decides which actions exist; its environment's
        // capabilities decide whether the server can run them.
        const threadKind = threadKindForSidebarMode(
          sidebarModeForThread(thread, sidebarModes.classifier),
        );
        const capabilities = threadCapabilities(threadKind);
        const supportsSettlement =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
          true;
        const supportsSnooze =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true;
        const isSettled = settledThreadKeysRef.current.has(threadKey);
        const isSnoozed = snoozedThreadKeysRef.current.has(threadKey);
        // Presets resolve at menu-open time (same as the popover).
        const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat);
        const folderState = threadFolderState(thread, projectLabelDirectory);
        setSidebarContextMenuTarget(threadKey);
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildThreadActionMenuItems({
              canOperate: readEnvironmentScope(
                threadRef.environmentId,
                AuthOrchestrationOperateScope,
              ),
              capabilities,
              branch: thread.branch ?? null,
              isUnread: hasUnseenCompletion({
                ...thread,
                lastVisitedAt: resolveThreadLastVisitedAt(
                  thread.lastVisitedAt,
                  useUiStateStore.getState().threadLastVisitedAtById[threadKey],
                ),
              }),
              isPinned: thread.pinnedAt != null,
              isSettled,
              isSnoozed,
              canSnoozeNow: canSnooze(thread, { now: new Date().toISOString() }),
              isRunning: !threadRuntimeCanArchive(thread.runtime),
              isRegeneratingTitle: thread.titleRegeneration != null,
              confirmsDelete: confirmThreadDelete || capabilities.delete === "always-confirm",
              supports: {
                settlement: supportsSettlement,
                snooze: supportsSnooze,
                pinning:
                  serverConfigs.get(thread.environmentId)?.environment.capabilities
                    .threadPinning === true,
                titleRegeneration:
                  serverConfigs.get(thread.environmentId)?.environment.capabilities
                    .threadTitleRegeneration === true,
              },
              snoozePresets,
              limitResume: usageLimitMenuState(
                thread,
                (
                  appAtomRegistry.get(serverEnvironment.settingsValueAtom(thread.environmentId)) ??
                  DEFAULT_SERVER_SETTINGS
                ).autoResumeLimitedThreads,
                Date.now(),
              ),
              folder: {
                current: folderState.current && {
                  key: folderState.current.key,
                  id: folderState.current.label.id,
                  name: folderState.current.label.name,
                },
                removable: folderState.removable,
                options: folderState.options.map((entry) => ({
                  id: entry.label.id,
                  name: entry.label.name,
                  color: entry.label.color,
                })),
                canMove: appAtomRegistry.get(
                  serverEnvironment.moveThreadProjectFolder.permissionAtom(thread.environmentId),
                ),
                forks: threadForksIntoProjects(thread),
              },
            }),
            position,
          ),
        );
        setSidebarContextMenuTarget(null);
        if (clicked._tag === "Failure" || clicked.value === null) return;
        if (clicked.value.startsWith("open-project:")) {
          const entry = projectLabelDirectory.byKey.get(
            clicked.value.slice("open-project:".length) as ProjectLabelKey,
          );
          if (entry) openProjectView(entry);
          return;
        }
        if (clicked.value === "new-folder") {
          // The right-clicked thread moves into the project it just made.
          const previous = priorFiling(folderState);
          openCreateProjectDialog({
            environmentId: thread.environmentId,
            onCreated: (id, name) =>
              void moveThreadToFolder({ thread, folder: { id, name }, previous }),
          });
          return;
        }
        const clickedId = clicked.value;
        if (clickedId === "remove-folder" || clickedId.startsWith("move-folder:")) {
          const target =
            clickedId === "remove-folder"
              ? null
              : (folderState.options.find(
                  (entry) => entry.label.id === clickedId.slice("move-folder:".length),
                ) ?? null);
          if (clickedId !== "remove-folder" && target === null) return;
          await moveThreadToFolder({
            thread,
            folder: target && { id: target.label.id, name: target.label.name },
            previous: priorFiling(folderState),
          });
          return;
        }
        if (threadActionRequiresOperate(clicked.value) && !checkThreadOperations([thread])) return;
        if (clicked.value?.startsWith("snooze:")) {
          const preset =
            clicked.value === "snooze:custom"
              ? await requestCustomSnooze()
              : snoozePresets.find((candidate) => `snooze:${candidate.id}` === clicked.value);
          if (preset) attemptSnooze(threadRef, preset);
          return;
        }
        switch (clicked.value) {
          case "start-work":
            openCommandPalette({ open: "start-work", threadRef });
            return;
          case "pin":
          case "unpin":
            togglePin(threadRef, clicked.value === "unpin");
            return;
          case "settle":
            attemptSettle(threadRef);
            return;
          case "unsettle":
            attemptUnsettle(threadRef);
            return;
          case "unsnooze":
            attemptUnsnooze(threadRef);
            return;
          case "limit-resume:on":
          case "limit-resume:off": {
            const stop = usageLimitStopForThread(thread);
            const autoResume = clicked.value === "limit-resume:on";
            const limitRecovery = stop && usageLimitAutoResumeUpdate(stop, autoResume);
            if (!limitRecovery) return;
            const result = await updateThreadMetadata({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, limitRecovery },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: autoResume ? "Could not schedule resume" : "Could not cancel resume",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "rename":
            startThreadRename(threadRef, thread.title);
            return;
          case "regenerate-title":
            regenerateThreadTitle(threadRef);
            return;
          case "mark-unread":
            markThreadUnread(threadRef);
            return;
          case "mark-read":
            markThreadRead(threadRef);
            return;
          case "agent-settings":
            navigateToThread(threadRef);
            requestAgentView(
              agentViewKey({
                environmentId: threadRef.environmentId,
                conversationThreadId: threadRef.threadId,
              }),
              "responsibilities",
            );
            return;
          case "copy-thread-link": {
            const link = formatThreadLink(thread.id, thread.title);
            copyThreadLinkToClipboard(link, { link });
            return;
          }
          case "copy-path":
            if (!threadWorkspacePath) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Path unavailable",
                  description: "This thread does not have a workspace path to copy.",
                }),
              );
              return;
            }
            copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
            return;
          case "copy-branch":
            if (thread.branch) {
              copyBranchToClipboard(thread.branch, { branch: thread.branch });
            }
            return;
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id, threadTitle: thread.title });
            return;
          case "archive": {
            if (confirmThreadArchive) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(`Archive thread "${thread.title}"?`),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            let didArchive = false;
            const result = await archiveThread(threadRef, {
              onArchived: () => {
                didArchive = true;
              },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: didArchive
                    ? "Thread archived, but navigation failed"
                    : "Failed to archive thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
              return;
            }
            return;
          }
          case "delete": {
            if (capabilities.delete === false) return;
            if (confirmThreadDelete || capabilities.delete === "always-confirm") {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                  { variant: "destructive" },
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const result = await deleteThread(threadRef);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to delete thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
              return;
            }
            return;
          }
          default:
            return;
        }
      })();
    },
  );

  // A Work repository heading's menu: what belongs to the repository rather
  // than to one of its threads.
  const handleRepositoryContextMenu = useStableCallback(
    (projectRef: ScopedProjectRef, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const folder =
          projectLabelDirectory.labels.find(
            (entry) =>
              entry.environmentId === projectRef.environmentId &&
              entry.label.repositoryIds.includes(projectRef.projectId),
          ) ?? null;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildRepositoryActionMenuItems({
              folder: folder && { key: folder.key, name: folder.label.name },
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure" || clicked.value === null) return;
        if (clicked.value === "project-settings") {
          const projectGroup = projectGroupsRef.current.find((group) =>
            group.memberProjectRefs.some(
              (ref) =>
                ref.environmentId === projectRef.environmentId &&
                ref.projectId === projectRef.projectId,
            ),
          );
          if (projectGroup) openProjectSettings(projectGroup, projectRef);
          return;
        }
        if (clicked.value === "new-thread") {
          const result = await settlePromise(() => handleNewThreadRef.current(projectRef));
          if (result._tag === "Failure") {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not create thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        if (folder) openProjectView(folder);
      })();
    },
  );

  // Thread jump (cmd+1..9) and prev/next traversal reuse the same commands as
  // v1 — the keybinding layer is shared, only the ordered list differs.
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          modelPickerOpen: isModelPickerOpen(),
          isWeb: !isElectron,
          isDesktop: isElectron,
        },
      });
      const navigateToThreadKey = (targetThreadKey: string | null) => {
        if (!targetThreadKey) return false;
        const targetThread = threadByKey.get(targetThreadKey);
        if (!targetThread) return false;
        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return true;
      };
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        navigateToThreadKey(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeThreadKey,
            direction: traversalDirection,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) return;
      navigateToThreadKey(orderedThreadKeys[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [keybindings, navigateToThread, orderedThreadKeys, routeThreadKey, threadByKey]);

  // Same predicate as v1: hints show only while the held modifiers exactly
  // match a thread-jump binding. Adding Shift (screenshots) or Alt no
  // longer matches ⌘1..9, so the overlay hides for chords like ⌘⇧4.
  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform: navigator.platform,
      context: {
        terminalFocus: terminalFocused,
        modelPickerOpen: isModelPickerOpen(),
        isWeb: !isElectron,
        isDesktop: isElectron,
      },
    },
  );
  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow, updateThreadJumpHintsVisibility]);

  // One click opens the new-thread screen in the project you're in (active
  // thread's project, falling back to the top project), the same resolution
  // as chat.newLocal. The screen's own project picker changes it, and the
  // command palette still offers "New thread in..." to pick first.
  const handleNewThreadClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void startNewThreadFromContext({
      activeDraftThread: newThreadContext.activeDraftThread,
      activeThread: newThreadContext.activeThread ?? undefined,
      defaultProjectRef: newThreadContext.defaultProjectRef,
      handleNewThread: newThreadContext.handleNewThread,
    });
  }, [isMobile, newThreadContext, setOpenMobile]);

  // The button does what chat.newLocal does, so it advertises that shortcut.
  const newThreadShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newLocal");
  // Each tab's own primary actions at the end of the search dock.
  const dockActions = ((): SidebarDockAction[] => {
    switch (sidebarMode) {
      case "chats":
        return [
          {
            id: "new-chat",
            label: sidebarModeActions.newItemLabel,
            shortcutLabel: shortcutLabelForCommand(keybindings, "chat.newWithoutProject"),
            icon: SquarePenIcon,
            onClick: sidebarModeActions.startChat,
          },
        ];
      case "tasks":
        return [
          // Add repository only shows once one exists; the empty state offers it otherwise.
          ...(projectGroups.length > 0
            ? [
                {
                  id: "add-repository",
                  label: "Add repository",
                  icon: FolderPlusIcon,
                  onClick: openAddProjectCommandPalette,
                },
              ]
            : []),
          {
            id: "new-task",
            label: sidebarModeActions.newItemLabel,
            shortcutLabel: newThreadShortcutLabel,
            icon: SquarePenIcon,
            onClick: handleNewThreadClick,
            disabled: projects.length === 0,
          },
        ];
      case "agents":
        return [
          {
            id: "new-agent",
            label: sidebarModeActions.newItemLabel,
            icon: SquarePenIcon,
            onClick: sidebarModeActions.createAgent,
          },
        ];
    }
  })();
  const threadHeader = (
    <SidebarSearchDock
      actions={dockActions}
      searchInputRef={threadSearchInputRef}
      searchQuery={threadSearchQuery}
      onSearchQueryChange={(value) => {
        setThreadSearchQuery(value);
        setActiveSearchResultIndex(0);
      }}
      onSearchKeyDown={handleThreadSearchKeyDown}
      searchLabel="Search threads"
      clearLabel="Clear thread search"
      results={{
        listId: "sidebar-thread-search-results",
        optionId: (index) => `sidebar-thread-search-result-${index}`,
        visible: isSearchingThreads,
        count: threadSearchResults.length,
        activeIndex: activeSearchResultIndex,
      }}
      onClearSearch={clearThreadSearch}
    />
  );
  return (
    <>
      <ThreadContextDragGhost />
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          // Desktop switches modes from the navigation rail; the mobile sheet
          // keeps the segmented switcher above the list.
          navRailVisible ? null : (
            <SidebarGroup className="z-[1]">
              <SidebarModeSwitcher
                mode={sidebarMode}
                onModeChange={sidebarModes.selectMode}
                decisionsWaiting={sidebarModes.decisionsWaiting}
                keybindings={keybindings}
              />
            </SidebarGroup>
          )
        }
        fixedFooter={
          // Search and the add/new actions dock under the list, which stacks
          // up from the bottom toward them.
          // Lifted above the stage backdrop, whose fade would otherwise paint
          // across the search field's outline.
          <SidebarGroup className="z-[1]">
            {sidebarMode === "tasks" ? (
              <SidebarShelfBar
                activeIcon={SIDEBAR_MODE_ICONS.tasks}
                activeLabel="All tasks"
                activeEmptyLabel="Nothing in progress"
                activeCount={activeThreads.length}
                attentionCount={attentionThreadKeys.size}
                snoozedCount={snoozedThreads.length}
                settledCount={settledThreads.length}
                openShelf={openShelf}
                onOpenShelf={openSidebarShelf}
              />
            ) : null}
            {sidebarMode === "agents" ? <AgentsShelfBar /> : null}
            {threadHeader}
          </SidebarGroup>
        }
      >
        <SidebarGroup ref={sidebarModeListRef} className="flex-1 justify-end" role="presentation">
          {isSearchingThreads ? (
            threadSearchResults.length > 0 ? (
              <TooltipProvider
                key="sidebar-thread-search-tooltips-150"
                delay={150}
                closeDelay={0}
                timeout={400}
              >
                <SidebarList
                  id="sidebar-thread-search-results"
                  role="listbox"
                  aria-label="Thread search results"
                >
                  {threadSearchResults.map((thread, index) => {
                    const threadKey = scopedThreadKey(
                      scopeThreadRef(thread.environmentId, thread.id),
                    );
                    return (
                      <SidebarSearchResultRow
                        isSettled={settledThreadKeys.has(threadKey)}
                        key={threadKey}
                        thread={thread}
                        project={
                          projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                        }
                        // Chats list rows carry no project icon; search matches that.
                        showProjectIcon={
                          sidebarModeForThread(thread, sidebarModes.classifier) !== "chats"
                        }
                        projectDisplayName={
                          projectDisplayNameByKey.get(
                            `${thread.environmentId}:${thread.projectId}`,
                          ) ?? null
                        }
                        environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                        environmentMachine={
                          environmentMachineById.get(thread.environmentId) ?? "server"
                        }
                        providerEntryByInstanceId={
                          providerEntriesByEnvironment.get(thread.environmentId) ??
                          EMPTY_PROVIDER_ENTRIES
                        }
                        isHighlighted={activeSearchResultIndex === index}
                        isRouteActive={routeThreadKey === threadKey}
                        resultId={`sidebar-thread-search-result-${index}`}
                        searchMatch={
                          threadSearchMatchByKey.get(
                            threadSearchMatchKey({
                              environmentId: thread.environmentId,
                              threadId: thread.id,
                            }),
                          ) ?? null
                        }
                        searchQuery={threadSearchQuery}
                        onHighlight={() => setActiveSearchResultIndex(index)}
                        onSelect={() => selectThreadSearchResult(thread)}
                        onFileDropThreads={handleThreadFileDrop}
                      />
                    );
                  })}
                </SidebarList>
              </TooltipProvider>
            ) : (
              <p
                role="status"
                className="flex flex-1 items-center justify-center px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                {threadSearch.isPending ? "Searching thread messages…" : "No threads found"}
              </p>
            )
          ) : null}
          {!isSearchingThreads && sidebarMode === "agents" ? (
            <SidebarAgentsList
              activeThreadKey={
                routeThreadRef ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}` : null
              }
              onOpenThread={navigateToThread}
              onCreateAgent={sidebarModeActions.createAgent}
            />
          ) : null}
          {!isSearchingThreads && modeListsThreads ? (
            // Work's cards sort within their project groups (SidebarSortableFoldRow).
            <SidebarThreadListProviders
              key="sidebar-thread-tooltips-150"
              sensors={workSortSensors}
              collisionDetection={workSortCollision}
              onDragStart={handleWorkSortStart}
              onDragEnd={handleWorkSortEnd}
              describe={describeWorkSortItem}
            >
              <SidebarDragLifecycle onUnmount={cancelThreadDrag} />
              {/* Announces keyboard reorders (alt+arrow) in Work. */}
              <span role="status" aria-live="polite" className="sr-only">
                {sidebarMode === "tasks" ? workReorderAnnouncement : ""}
              </span>
              <SidebarList
                ref={attachListMotionRef}
                onTransitionEnd={handleListTransitionEnd}
                // VoiceOver treats an exposed list as an interaction boundary,
                // which hides its rows from ordinary linear navigation. A
                // presentational list also makes its implicit listitems
                // presentational while preserving every descendant control.
                role="presentation"
                // Work's cards carry their own gap (SidebarCardItem); Chats' rows take the list's.
                density={sidebarMode === "tasks" ? "cards" : "rows"}
                onKeyDown={sidebarMode === "tasks" ? handleWorkListKeyDown : undefined}
                grow={sidebarListItems.length > 0}
                className={cn(
                  // An action sweep owns the pointer: rows it passes over
                  // neither show hover actions nor open tooltips, even
                  // controls that opt back in, like the Woke pill.
                  actionSweep !== null && "**:pointer-events-none",
                )}
              >
                {(() => {
                  // Only the row being renamed gets the button, and only when
                  // its server can regenerate and is not already doing so.
                  const regenerateTitleFor = (thread: EnvironmentThreadShell, threadKey: string) =>
                    renamingThreadKey === threadKey &&
                    thread.titleRegeneration == null &&
                    serverConfigs.get(thread.environmentId)?.environment.capabilities
                      .threadTitleRegeneration === true
                      ? regenerateThreadTitle
                      : undefined;
                  const renderThreadRow = (
                    thread: EnvironmentThreadShell,
                    section: SidebarSection,
                    projectInHeading = false,
                  ) => {
                    const threadKey = scopedThreadKey(
                      scopeThreadRef(thread.environmentId, thread.id),
                    );
                    // Settled and snoozed are the ONLY things that collapse a
                    // row: every other thread is a full card. Density comes
                    // from users (or the auto rules) actually parking work,
                    // not from the sidebar second-guessing what still matters.
                    // Working rows stay cards so their live status shows.
                    if (sidebarMode === "chats") {
                      return (
                        <SidebarChatRow
                          key={`${threadKey}`}
                          thread={thread}
                          folder={folderFor(thread)}
                          animateFolder={chatProjectMetaAnimates}
                          isActive={routeThreadKey === threadKey}
                          jumpLabel={showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null}
                          timeLabel={threadTimeLabel(thread)}
                          isRenaming={renamingThreadKey === threadKey}
                          renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ""}
                          onThreadClick={handleThreadClick}
                          onThreadActivate={navigateToThread}
                          onStartRename={startThreadRename}
                          onRenameTitleChange={setRenamingTitle}
                          onCommitRename={commitThreadRename}
                          onCancelRename={cancelThreadRename}
                          onRegenerateTitle={regenerateTitleFor(thread, threadKey)}
                          onContextMenu={handleThreadContextMenu}
                          onContextDragStart={startThreadContextDrag}
                        />
                      );
                    }
                    // Work shows every filter as the same cards.
                    const isCard =
                      sidebarMode === "tasks" || section === "active" || section === "working";
                    const rowVariant = isCard ? "card" : "slim";
                    return (
                      <SidebarThreadRow
                        // Fade between card and compact rows.
                        key={`${threadKey}:${rowVariant}`}
                        thread={thread}
                        variant={rowVariant}
                        // Snoozed rows wake, settled rows un-settle, and cards settle.
                        variantAction={
                          section === "snoozed"
                            ? "unsnooze"
                            : section === "settled"
                              ? "unsettle"
                              : "settle"
                        }
                        settlementSupported={
                          serverConfigs.get(thread.environmentId)?.environment.capabilities
                            .threadSettlement === true
                        }
                        snoozeSupported={
                          serverConfigs.get(thread.environmentId)?.environment.capabilities
                            .threadSnooze === true
                        }
                        // Work cards name their project and repository on their first line.
                        repositoryName={repositoryNameFor(thread)}
                        onRepositoryContextMenu={handleRepositoryContextMenu}
                        folder={sidebarMode === "tasks" ? workFolderFor(thread) : folderFor(thread)}
                        projectInHeading={projectInHeading}
                        sweepAction={actionSweep?.keys.has(threadKey) ? actionSweep.action : null}
                        snoozeWakeLabelText={
                          section === "snoozed" && thread.snoozedUntil != null
                            ? snoozeWakeLabel(thread.snoozedUntil, {
                                now: new Date().toISOString(),
                              })
                            : null
                        }
                        // All sections: a woken thread can classify straight
                        // into the settled tail (PR merged while snoozed), and
                        // the wake signal must survive the trip. Still-snoozed
                        // rows resolve to null on their own.
                        wokeAt={threadWokeAt(thread, { now: snoozeNow })}
                        isActive={routeThreadKey === threadKey}
                        jumpLabel={showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null}
                        environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                        environmentMachine={
                          environmentMachineById.get(thread.environmentId) ?? "server"
                        }
                        project={
                          projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                        }
                        projectDisplayName={
                          projectDisplayNameByKey.get(
                            `${thread.environmentId}:${thread.projectId}`,
                          ) ?? null
                        }
                        showWorkStatus={sidebarMode === "tasks"}
                        workAgentName={
                          thread.source.agent?.role === "work"
                            ? (sidebarModes.agentNameByKey.get(
                                `${thread.environmentId}:${thread.source.agent.id}`,
                              ) ?? null)
                            : null
                        }
                        providerEntryByInstanceId={
                          providerEntriesByEnvironment.get(thread.environmentId) ??
                          EMPTY_PROVIDER_ENTRIES
                        }
                        timestampFormat={timestampFormat}
                        onThreadClick={handleThreadClick}
                        onThreadActivate={navigateToThread}
                        onStartRename={startThreadRename}
                        onRenameTitleChange={setRenamingTitle}
                        onCommitRename={commitThreadRename}
                        onCancelRename={cancelThreadRename}
                        onRegenerateTitle={regenerateTitleFor(thread, threadKey)}
                        isRenaming={renamingThreadKey === threadKey}
                        renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ""}
                        onContextMenu={handleThreadContextMenu}
                        onSettle={attemptSettle}
                        onActionSweepStart={startActionSweep}
                        onUnsettle={attemptUnsettle}
                        onSnooze={attemptSnooze}
                        onUnsnooze={attemptUnsnooze}
                        onContextDragStart={startThreadContextDrag}
                        onAcknowledgeWoke={acknowledgeWoke}
                        onFileDropThreads={handleThreadFileDrop}
                      />
                    );
                  };
                  // In Work the count bar filters the list: the first segment
                  // shows active work (and drafts), each other one only its shelf.
                  const shownSection = sidebarMode === "tasks" ? (openShelf ?? "active") : null;
                  const items: ReactNode[] = [];
                  // Work's live cards (All, Needs attention) sit under project
                  // headings, "No project" last,
                  // each group in the order the user arranged (workRows) with
                  // its drafts newest at the bottom. A folded heading keeps
                  // only the open card; cards drag within their group.
                  if (workRows !== null) {
                    for (const group of workRows.groups) {
                      const sectionKey = workGroupSectionKey(group.key);
                      const collapsed = collapsedInSpace.includes(sectionKey);
                      const label = group.project?.name ?? "No project";
                      const groupFolder = group.project?.folder;
                      // Every group has a heading, "No project" included.
                      const projectInHeading = true;
                      items.push(
                        <SidebarGroupHeader
                          key={`work-group:${group.key}`}
                          label={label}
                          count={group.cards.length}
                          icon={
                            groupFolder ? (
                              <ProjectFolderIcon color={groupFolder.color} className="size-3.5" />
                            ) : undefined
                          }
                          collapse={{
                            open: !collapsed,
                            onToggle: () => toggleSection(sectionKey),
                            ariaLabel: `${label}, ${collapsed ? "expand" : "collapse"}`,
                          }}
                        />,
                      );
                      const sortItems = workSort.orders.get(group.key) ?? EMPTY_SORT_ITEMS;
                      const cards = group.cards.map((card) => {
                        if (card.kind === "thread") {
                          const thread = threadByKey.get(card.key);
                          if (!thread) return null;
                          return (
                            <SidebarSortableFoldRow
                              key={card.key}
                              id={card.key}
                              open={!collapsed}
                              sortable={
                                workSort.groupOf.has(card.key) && renamingThreadKey !== card.key
                              }
                              reducedMotion={reducedMotion}
                            >
                              {renderThreadRow(thread, card.section, projectInHeading)}
                            </SidebarSortableFoldRow>
                          );
                        }
                        const { draft } = card;
                        const projectKey = `${draft.environmentId}:${draft.projectId}` as const;
                        return (
                          <SidebarSortableFoldRow
                            key={card.key}
                            id={card.key}
                            open={!collapsed}
                            sortable={false}
                            reducedMotion={reducedMotion}
                          >
                            <SidebarWorkDraftCard
                              draftId={draft.draftId}
                              branch={draft.branch}
                              project={projectByKey.get(projectKey) ?? null}
                              projectDisplayName={projectDisplayNameByKey.get(projectKey) ?? null}
                              environmentId={draft.environmentId}
                              threadId={draft.threadId}
                              repositoryName={repositoryNameFor(draft)}
                              repositoryFolder={repositoryFolderFor(
                                draft.environmentId,
                                draft.projectId,
                              )}
                              folderForLabel={folderForLabel}
                              projectInHeading={projectInHeading}
                              isActive={draft.draftId === routeDraftIdForRows}
                              onNavigate={navigateToDraft}
                              onContextMenu={handleDraftContextMenu}
                            />
                          </SidebarSortableFoldRow>
                        );
                      });
                      items.push(
                        <SortableContext
                          key={`work-sort:${group.key}`}
                          id={`work-sort:${group.key}`}
                          items={sortItems}
                          strategy={verticalListSortingStrategy}
                        >
                          {cards}
                        </SortableContext>,
                      );
                    }
                    return items;
                  }
                  if (shownSection === null)
                    items.push(
                      <SidebarDraftBlock
                        key="draft-sessions"
                        projectByKey={projectByKey}
                        projectDisplayNameByKey={projectDisplayNameByKey}
                        draftInMode={sidebarModes.draftInMode}
                        routeDraftId={routeDraftIdForRows}
                        slim={sidebarMode === "chats"}
                        onNavigateToDraft={navigateToDraft}
                        onDraftContextMenu={handleDraftContextMenu}
                      />,
                    );
                  const chatDateGroupOf =
                    sidebarMode === "chats" ? createChatDateGrouper(new Date()) : null;
                  // Settled is one flat list, newest settled at the top.
                  const flatShelfRows: ReactNode[] | null = shownSection === "settled" ? [] : null;
                  for (const item of sidebarListItems) {
                    if (item.kind === "thread") {
                      if (shownSection !== null && item.section !== shownSection) continue;
                      const thread = threadByKey.get(item.key)!;
                      if (flatShelfRows) {
                        flatShelfRows.push(renderThreadRow(thread, item.section));
                        continue;
                      }
                      const dateGroup =
                        item.section === "active" ? chatDateGroupOf?.(thread) : null;
                      if (dateGroup) {
                        const collapsed = collapsedInSpace.includes(dateGroup);
                        items.push(
                          <SidebarGroupHeader
                            key={`chat-date:${dateGroup}`}
                            label={CHAT_DATE_GROUP_LABELS[dateGroup]}
                            count={chatDateGroupCounts.get(dateGroup) ?? 0}
                            collapse={{
                              open: !collapsed,
                              onToggle: () => toggleSection(dateGroup),
                              ariaLabel: `${CHAT_DATE_GROUP_LABELS[dateGroup]}, ${collapsed ? "expand" : "collapse"}`,
                            }}
                          />,
                        );
                      }
                      // A folded date group keeps only the open chat; the
                      // rest fold shut under the heading.
                      const chatGroup =
                        item.section === "active" && sidebarMode === "chats"
                          ? chatDateGroupByKey.get(item.key)
                          : undefined;
                      if (chatGroup !== undefined) {
                        items.push(
                          <SidebarFoldRow
                            key={item.key}
                            // A fold hides every row; the open one stays selected.
                            open={!collapsedInSpace.includes(chatGroup)}
                          >
                            {renderThreadRow(thread, item.section)}
                          </SidebarFoldRow>,
                        );
                        continue;
                      }
                      items.push(renderThreadRow(thread, item.section));
                      continue;
                    }
                    switch (item.marker) {
                      case "working-header":
                        // In Work the count bar labels the lists, so shelves have no header.
                        if (shownSection !== null) break;
                        items.push(
                          <SidebarSectionHeader
                            key="working-shelf-header"
                            marker="working-header"
                            label="Working"
                            count={workingThreads.length}
                            toggle={{
                              expanded: workingShelfExpanded,
                              onToggle: toggleWorkingShelf,
                            }}
                          />,
                        );
                        break;
                      case "snoozed-header":
                        // In Work the count bar labels the lists, so shelves have no header.
                        if (shownSection !== null) break;
                        items.push(
                          <SidebarSectionHeader
                            key="snoozed-shelf-header"
                            marker="snoozed-header"
                            label="Snoozed"
                            count={snoozedThreads.length}
                            toggle={{
                              expanded: snoozedShelfExpanded,
                              onToggle: toggleSnoozedShelf,
                            }}
                          />,
                        );
                        break;
                      case "settled-header":
                        // In Work the count bar labels the lists, so shelves have no header.
                        if (shownSection !== null) break;
                        items.push(
                          <SidebarSectionHeader
                            key="settled-shelf-header"
                            marker="settled-header"
                            label="Settled"
                            count={settledThreads.length}
                            toggle={{
                              expanded: settledShelfExpanded,
                              onToggle: toggleSettledShelf,
                            }}
                          />,
                        );
                        break;
                    }
                  }
                  if (flatShelfRows) items.push(...flatShelfRows);
                  return items;
                })()}
                {sidebarMode === "tasks" && settledShelfExpanded && hiddenSettledCount > 0 ? (
                  // Settled runs newest first from the top, so older pages
                  // land below the last row.
                  <SidebarListRevealSentinel
                    key={`settled:${settledVisibleCount}`}
                    edge="bottom"
                    onReveal={revealMoreSettled}
                  />
                ) : null}
                {chatWindow !== null && chatWindow.hiddenCount > 0 ? (
                  <SidebarListRevealSentinel
                    key={`chats:${chatVisibleCount}`}
                    edge="bottom"
                    onReveal={revealMoreChats}
                  />
                ) : null}
              </SidebarList>
            </SidebarThreadListProviders>
          ) : null}
          {!isSearchingThreads &&
          modeListsThreads &&
          visibleDraftSessionCount === 0 &&
          activeThreads.length +
            workingThreads.length +
            snoozedThreads.length +
            settledThreads.length ===
            0 ? (
            <SidebarListEmptyState
              label={
                sidebarMode === "chats"
                  ? "No chats yet"
                  : projects.length === 0
                    ? "No repositories yet"
                    : "No work yet"
              }
              action={
                sidebarMode === "chats"
                  ? // Chats need no repository, so the empty list offers a chat.
                    { label: "New chat", onClick: sidebarModeActions.startChat }
                  : projects.length === 0
                    ? { label: "Add repository", onClick: openAddProjectCommandPalette }
                    : undefined
              }
            />
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter utilityMenu={!navRailVisible} />
    </>
  );
}

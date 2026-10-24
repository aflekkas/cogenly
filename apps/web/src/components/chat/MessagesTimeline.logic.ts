import { worktreeSetupAgentStarted } from "@cogenly/client-runtime/worktree-setup";
export { worktreeSetupAgentStarted } from "@cogenly/client-runtime/worktree-setup";
import { isLiveSubagentTurnItem } from "@cogenly/client-runtime/state/subagentRuntime";
import * as DateTime from "effect/DateTime";
import * as Equal from "effect/Equal";
import {
  assistantCitationLabel,
  collectAssistantCitations,
} from "@cogenly/shared/assistantCitations";
import { shallow } from "zustand/vanilla/shallow";
import { renderCodexDirectivesForCopy } from "@cogenly/shared/codexMarkdownDirectives";
import { reasoningPlainText } from "@cogenly/client-runtime/work-log/reasoning-text";
import {
  resolveWorkLogNotice,
  readToolRecord,
  resolveWorkLogTool,
  workLogToolGroupLabel,
  type WorkLogToolCallInput,
  type WorkLogToolIcon,
} from "@cogenly/client-runtime/work-log/tool-registry";
import {
  liveActivityToolStatus,
  resolveWorkEntryTool,
  toolGroupIcon,
  workEntryToolCall,
  summarizeToolGroup,
} from "@cogenly/client-runtime/work-log/presentation";
import {
  deriveRevertTurnCountByUserMessageId,
  formatDuration,
  isStreamingMessageTextUpdate,
  isStreamingTurnItemTextUpdate,
  timelineEntryIsPersistentResourceCard,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import {
  type ChatMessage,
  type ProposedPlan,
  type ThreadShell,
  type TurnDiffSummary,
} from "../../types";
import {
  type MessageId,
  type WorktreeSetupSnapshot,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  type RunAttemptId,
  RunId,
  type ThreadId,
  type TurnItemId,
} from "@cogenly/contracts";
import type { ThreadRunSummary } from "@cogenly/client-runtime/state/shell";
import {
  resolveT3McpToolDefinition,
  resolveT3McpToolPresentation,
  type T3McpToolPresentation,
} from "@cogenly/shared/t3McpToolPresentation";
import { compactDynamicToolOutput } from "@cogenly/shared/toolOutput";
import { htmlRenderReferencesEqual, type HtmlRenderReference } from "@cogenly/shared/htmlRender";
import { mcpAppReferencesEqual, type McpAppReference } from "@cogenly/shared/mcpApp";
import { collectToolFilePaths } from "@cogenly/shared/toolActivity";
import { isWindowsAbsolutePath } from "@cogenly/shared/path";

function timelineEntryRunId(entry: TimelineEntry): RunId | null {
  if (entry.kind === "message") {
    return entry.message.role === "assistant" ? (entry.message.runId ?? null) : null;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.runId;
  }
  if (entry.kind === "html-render" || entry.kind === "mcp-app") return entry.runId;
  return entry.kind === "work" ? (entry.entry.runId ?? null) : null;
}

/** Whether the entry still represents live activity, not a settled result. */
function workEntryIsActiveTurnActivity(entry: WorkLogEntry): boolean {
  return (
    entry.toolLifecycleStatus === "inProgress" ||
    (entry.toolLifecycleStatus === undefined &&
      (entry.sourceActivityKind === "task.progress" || workLogEntryIsToolLike(entry)))
  );
}

/**
 * A work row's label, from the registry for every tool call and notice. Reasoning
 * reads as its plain text; anything else keeps the label it was projected with.
 */
export function workEntryLabel(
  entry: WorkLogEntry,
  fallbackStatus?: "inProgress" | "completed",
): string {
  if (entry.itemType === "reasoning" || entry.tone === "thinking") {
    return reasoningPlainText(entry.detail ?? "") || entry.label;
  }
  const tool = resolveWorkEntryTool(entry, fallbackStatus);
  if (tool) return tool.label;
  // Provider errors keep their own wording, which explains retries and limits.
  const item = entry.structuredPayload;
  const notice = item && item.type !== "error" ? resolveWorkLogNotice(item) : null;
  return notice?.label ?? entry.label;
}

/** A linked thread's live title, or null once it is archived or deleted. */
export function threadTargetTitle(
  shell: Pick<ThreadShell, "title" | "archivedAt" | "deletedAt"> | null,
) {
  if (!shell || shell.archivedAt !== null || shell.deletedAt !== null) return null;
  return shell.title.trim() || null;
}

export type WorkEntryRun =
  | { readonly kind: "entry"; readonly id: string; readonly entry: WorkLogEntry }
  | {
      readonly kind: "run";
      readonly id: string;
      readonly label: string;
      readonly icon: WorkLogToolIcon;
      readonly entries: ReadonlyArray<WorkLogEntry>;
    };

/**
 * Collapses consecutive calls of the same registry tool group into one
 * expandable `Searched chats ×3` row, like reasoning groups read `Thought (×2)`.
 */
export function collapseWorkEntryRuns(entries: ReadonlyArray<WorkLogEntry>): WorkEntryRun[] {
  type Pending = {
    key: string;
    icon: WorkLogToolIcon;
    calls: WorkLogToolCallInput[];
    entries: WorkLogEntry[];
  };
  const runs: WorkEntryRun[] = [];
  const flush = (pending: Pending | null) => {
    if (!pending) return;
    const [first] = pending.entries;
    if (!first) return;
    runs.push(
      pending.entries.length === 1
        ? { kind: "entry", id: first.id, entry: first }
        : {
            kind: "run",
            id: `run:${first.id}`,
            label: workLogToolGroupLabel(pending.calls) ?? first.label,
            icon: pending.icon,
            entries: pending.entries,
          },
    );
  };
  let pending: Pending | null = null;
  for (const entry of entries) {
    const call = entry.itemType === "reasoning" ? null : workEntryToolCall(entry, "completed");
    const tool = call ? resolveWorkLogTool(call) : null;
    if (!call || !tool || tool.source === "generic") {
      flush(pending);
      pending = null;
      runs.push({ kind: "entry", id: entry.id, entry });
      continue;
    }
    if (pending === null || pending.key !== tool.groupKey) {
      flush(pending);
      pending = { key: tool.groupKey, icon: tool.icon, calls: [], entries: [] };
    }
    pending.calls.push(call);
    pending.entries.push(entry);
  }
  flush(pending);
  return runs;
}

function workEntryReadRawPaths(entry: WorkLogEntry): readonly string[] {
  const fromChanged = entry.changedFiles ?? [];
  if (fromChanged.length > 0) return fromChanged;
  const structured = entry.structuredPayload;
  if (structured?.type === "dynamic_tool") {
    const structuredPaths = collectToolFilePaths({ input: structured.input });
    if (structuredPaths.length > 0) return structuredPaths;
  }
  const data = entry.toolData;
  return collectToolFilePaths(
    data !== null && typeof data === "object" && !Array.isArray(data) ? data : undefined,
  );
}

/** Inspectable read-file output is the path when we have one, otherwise nothing. */
export function workEntryReadOutput(
  entry: Pick<
    WorkLogEntry,
    "changedFiles" | "detail" | "viewedImagePath" | "structuredPayload" | "toolData"
  >,
  workspaceRoot: string | undefined,
): string | null {
  const paths = [
    ...new Set(
      workEntryReadRawPaths(entry as WorkLogEntry)
        .map((path) => {
          const trimmed = path.trim().replaceAll("\\", "/");
          if (!workspaceRoot || trimmed.startsWith("/") || isWindowsAbsolutePath(trimmed)) {
            return trimmed;
          }
          const root = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
          const relative = trimmed.replace(/^\.\//, "").replace(/^\/+/, "");
          return `${root}/${relative}`;
        })
        .filter((path) => path.length > 0),
    ),
  ];
  if (paths.length > 0) {
    return paths.join("\n");
  }
  return null;
}

/** The live row's label: the same registry label, in the present tense while the group works. */
export function liveWorkEntryLabel(entry: WorkLogEntry, active: boolean) {
  const status = liveActivityToolStatus(entry.toolLifecycleStatus, active);
  if (entry.itemType === "reasoning") {
    return (
      reasoningPlainText(entry.detail ?? "") || (status === "inProgress" ? "Thinking" : "Thought")
    );
  }
  return workEntryLabel({ ...entry, toolLifecycleStatus: status });
}

export function workEntryIsVisibleInGroup(
  entry: WorkLogEntry,
  expandedToolGroupEntry = false,
): boolean {
  if (entry.itemType === "reasoning") return Boolean(entry.detail?.trim());
  return (
    (expandedToolGroupEntry &&
      (entry.toolLifecycleStatus === "inProgress" ||
        entry.sourceActivityKind === "task.progress")) ||
    // A stopped call is an outcome ("Stopped sleep"), not an empty row.
    entry.toolLifecycleStatus === "stopped" ||
    !workEntryIndicatesToolNeutralStatus(entry)
  );
}
const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export interface WorkGroupScrollAnchor {
  readonly entryId: string;
  readonly offset: number;
}

/** Restore a visible tool, including a position partway through its expanded output. */
export function resolveWorkGroupScrollIndex(
  entries: ReadonlyArray<{ readonly id: string }>,
  anchor: WorkGroupScrollAnchor | undefined,
): { index: number; viewOffset: number } | undefined {
  if (!anchor) return undefined;
  const index = entries.findIndex((entry) => entry.id === anchor.entryId);
  return index < 0 ? undefined : { index, viewOffset: -anchor.offset };
}

/** Only newly appended calls may follow the end, never status or output updates. */
export function shouldFollowWorkGroupAppend(
  previous: ReadonlyArray<{ readonly id: string }>,
  entries: ReadonlyArray<{ readonly id: string }>,
  distanceFromEnd: number,
): boolean {
  return (
    previous.length > 0 &&
    entries.length > previous.length &&
    distanceFromEnd <= 1 &&
    previous.every((entry, index) => entry.id === entries[index]?.id)
  );
}

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly isNearEnd?: boolean;
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

/**
 * The follow re-arm band (#5566): strict isAtEnd flickers false for a frame
 * while streaming content grows under the viewport, so follow re-arms within
 * this distance of the real content bottom instead.
 */
const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export function resolveTimelineIsAtEnd(state: TimelineEndState | undefined): boolean | undefined {
  if (!state) {
    return undefined;
  }
  const { contentLength, scroll, scrollLength } = state;
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd;
  }
  // contentLength includes the composer inset spacer, but the composer hides
  // the same amount of viewport, so the inset cancels: plain
  // contentLength - scroll - scrollLength is the gap between the last real row
  // and the visible edge above the composer. LegendList's own isAtEnd subtracts
  // the inset and is true anywhere in the bottom composer-height band, so it is
  // only a fallback here, never a short-circuit.
  return contentLength - scroll - scrollLength <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

/**
 * Side gutter between the viewport edge and the centered content column.
 * `contentWidth` is the rendered column width, which follows the Chat width
 * setting, so callers measure it rather than assume a fixed maximum.
 */
function resolveTimelineSideGutter(viewportWidth: number, contentWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0 || !Number.isFinite(contentWidth)) {
    return 0;
  }
  return Math.max(0, (viewportWidth - Math.min(viewportWidth, contentWidth)) / 2);
}

export function resolveTimelineMinimapHasPersistentGutter(
  viewportWidth: number,
  contentWidth: number,
): boolean {
  return (
    resolveTimelineSideGutter(viewportWidth, contentWidth) >= TIMELINE_MINIMAP_PERSISTENT_GUTTER
  );
}

const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

/**
 * The minimap overlays the viewport's left edge while the content column is
 * centered, so the side gutter between them shrinks under browser zoom, a
 * narrow pane, or a wider Chat width setting. A fixed-width hover strip would then sit on top of the message
 * text and swallow its pointer events. Cap the strip's width so it never
 * extends past the gutter into the content column; 0 disables the strip.
 */
export function resolveTimelineMinimapHitStripWidth(
  viewportWidth: number,
  contentWidth: number,
): number {
  const sideGutter = resolveTimelineSideGutter(viewportWidth, contentWidth);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

// The prev/next buttons are centered 4px into the strip and 20px wide, so
// their hitbox reaches 14px past the strip's left edge.
const TIMELINE_MINIMAP_NAVIGATION_REACH = 14;

/**
 * The prev/next buttons hang outside the strip's height, so the strip's own
 * width cap does not cover them. Keep them inert to the pointer unless the
 * gutter can hold them; keyboard focus still reaches them.
 */
export function resolveTimelineMinimapNavigationInteractive(collapsedWidth: number): boolean {
  return collapsedWidth >= TIMELINE_MINIMAP_NAVIGATION_REACH;
}

/**
 * Once the preview is open, keep the full preview and the space leading to it
 * interactive. The collapsed strip remains gutter-capped so it cannot block
 * selecting message text.
 */
export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  updatedAt: string;
  streaming: boolean;
}

export type TimelineLatestRun = Pick<
  ThreadRunSummary,
  "runId" | "status" | "startedAt" | "completedAt"
>;

const LIVE_ACTIVITY_ROW_ID = "live-activity-row";

export type MessagesTimelineRow = MessagesTimelineRowContent & {
  readonly continuesWorkLog?: boolean;
  /**
   * Set on rows an open fold reveals: the fold row's id, and whether the fold
   * was just collapsed and the row is animating out before it leaves.
   */
  readonly foldReveal?: { readonly foldId: string; readonly closing: boolean };
};

type MessagesTimelineRowContent =
  | {
      kind: "worktree-setup";
      id: string;
      createdAt: string | null;
      snapshot: WorktreeSetupSnapshot;
      embedded: boolean;
    }
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
      isExpandedToolGroup: boolean;
      displayLabel?: string;
      /** Set on an expanded group's details row. */
      groupId?: string;
      /** The group was just collapsed; its details animate out before leaving. */
      closing?: boolean;
    }
  | {
      kind: "work-live";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      groupedEntries: WorkLogEntry[];
      groupId: string;
      expanded: boolean;
      /** Collapsed, with its details still animating out below. */
      closing?: boolean;
      active: boolean;
      /** Latest reasoning in the live group, shown above the status line. */
      thought?: WorkLogEntry;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
    }
  | {
      kind: "thinking";
      id: string;
      createdAt: string | null;
      /** Tool calls this row stands in for after the latest one failed. */
      groupId?: string;
      expanded?: boolean;
      closing?: boolean;
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      runId?: RunId | null;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      closing?: boolean;
      summary: string;
      /** The registry icon most of the group's calls share. */
      summaryIcon: WorkLogToolIcon | "brain";
      /** A provider-supplied image icon, such as an integration's logo. */
      toolIcon?: WorkLogEntry["toolIcon"];
      hasFailure: boolean;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      runId: RunId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "attempt-fold";
      id: string;
      createdAt: string;
      runId: RunId;
      attemptId: RunAttemptId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "context-compaction";
      id: string;
      createdAt: string;
      label: string;
      active: boolean;
    }
  | {
      kind: "restart-divider";
      id: string;
      createdAt: string;
      /** Every restart notice this one divider stands for, oldest first. */
      restarts: ReadonlyArray<TimelineRestart>;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      projectedItem?: OrchestrationV2ProjectedTurnItem;
      durationStart: string;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      /**
       * The live activity indicator sits in this message's metadata slot. The
       * slot keeps the metadata row's height, so the turn settling swaps its
       * content without moving anything.
       */
      showLiveActivity?: true;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "assistant-meta";
      projectedItem?: OrchestrationV2ProjectedTurnItem;
      id: string;
      createdAt: string;
      message: ChatMessage;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
    }
  | {
      kind: "event";
      id: string;
      createdAt: string;
      projectedItem: OrchestrationV2ProjectedTurnItem;
      subagents?: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
      resourceSummary?: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "html-render";
      id: string;
      createdAt: string;
      htmlRender: HtmlRenderReference;
    }
  | {
      kind: "mcp-app";
      id: string;
      createdAt: string;
      sourceThreadId: ThreadId;
      itemId: TurnItemId;
      revision: string;
      mcpApp: McpAppReference;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }

  return result;
}

function workGroupId(timelineEntryId: string): string {
  return `work-group:${timelineEntryId}`;
}

export type TimelineToolPresentation = T3McpToolPresentation;
export const resolveTimelineToolPresentation = resolveT3McpToolPresentation;

function expandedWorkGroupRow(
  groupId: string,
  createdAt: string,
  groupedEntries: WorkLogEntry[],
  closing: boolean,
): Extract<MessagesTimelineRow, { kind: "work" }> {
  return {
    kind: "work",
    id: `${groupId}:details`,
    createdAt,
    groupedEntries,
    isExpandedToolGroup: true,
    groupId,
    ...(closing ? { closing: true } : {}),
  };
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  const visible = showCopyButton && hasText && !streaming;
  return {
    text: hasText ? (visible ? renderCodexDirectivesForCopy(text) : text) : null,
    visible,
  };
}

/**
 * An assistant message the provider never finished: the server closes a
 * stream the provider dropped (a steer restarting it mid-sentence) as
 * interrupted, so its text may be a fragment.
 */
function isCutOffAssistantMessage(entry: TimelineEntry) {
  const item = entry.kind === "message" ? entry.projectedItem?.item : undefined;
  return item?.type === "assistant_message" && item.status === "interrupted";
}

/** Runs the user stopped. Nothing in them folds, and their last words stand. */
function interruptedTimelineRunIds(entries: ReadonlyArray<TimelineEntry>) {
  const interrupted = new Set<RunId>();
  for (const entry of entries) {
    if (
      entry.kind === "event" &&
      entry.projectedItem.item.runId !== null &&
      (entry.projectedItem.item.type === "run_interrupt_request" ||
        entry.projectedItem.item.type === "run_interrupt_result")
    ) {
      interrupted.add(entry.projectedItem.item.runId);
    }
  }
  return interrupted;
}

/**
 * Each response's answer: its last assistant message. A cut-off fragment
 * never displaces a whole message in a run that went on to finish, so the
 * real answer stays visible and the fragment folds away with the work. A run
 * that was itself stopped or failed keeps its last message, partial or not.
 */
export function deriveTerminalAssistantMessageIds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  cutShortRunIds: ReadonlySet<RunId>,
) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  const wholeAnswerResponseKeys = new Set<string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.runId
      ? `turn:${message.runId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    if (isCutOffAssistantMessage(timelineEntry)) {
      const runCutShort = message.runId != null && cutShortRunIds.has(message.runId);
      if (!runCutShort && wholeAnswerResponseKeys.has(responseKey)) continue;
    } else {
      wholeAnswerResponseKeys.add(responseKey);
    }
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

/** Row id of a turn's "Worked for ..." fold. */
export function turnFoldRowId(runId: RunId): string {
  return `turn-fold:${runId}`;
}

/** Row id of a superseded attempt's fold. */
export function attemptFoldRowId(attemptId: RunAttemptId): string {
  return `attempt-fold:${attemptId}`;
}

interface TurnFold {
  runId: RunId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
}

interface SupersededAttemptFold {
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly anchorEntryId: string;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
}

/**
 * Final replies of superseded attempts that finished before the steer replaced
 * them. A steer stamps the attempt's completedAt when it is dispatched, and the
 * provider closes a reply it cut off only after that, so a reply whose item
 * completed earlier was whole. Item status alone cannot tell: an interrupted
 * stream also closes as `completed`. The reply must be the attempt's last
 * output; trailing tool or reasoning work means the attempt was still going.
 */
function completeSupersededReplyEntryIds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
): ReadonlySet<string> {
  const lastOutputByAttemptId = new Map<RunAttemptId, TimelineEntry>();
  for (const entry of timelineEntries) {
    if (
      entry.attempt?.status !== "superseded" ||
      (entry.kind === "message" && entry.message.role === "user") ||
      (entry.kind === "work" &&
        (entry.entry.itemType === "system_notice" || entry.entry.itemType === "notification")) ||
      (entry.kind !== "message" && entry.kind !== "work")
    ) {
      continue;
    }
    lastOutputByAttemptId.set(entry.attempt.id, entry);
  }
  const replyEntryIds = new Set<string>();
  for (const entry of lastOutputByAttemptId.values()) {
    const supersededAt = entry.attempt?.completedAt ?? null;
    const item = entry.kind === "message" ? entry.projectedItem?.item : undefined;
    if (
      entry.kind === "message" &&
      !entry.message.streaming &&
      item?.type === "assistant_message" &&
      item.status === "completed" &&
      item.completedAt !== null &&
      supersededAt !== null &&
      DateTime.isLessThan(item.completedAt, supersededAt)
    ) {
      replyEntryIds.add(entry.id);
    }
  }
  return replyEntryIds;
}

/**
 * Groups only provider output owned by an explicitly superseded V2 attempt
 * that the steer cut off. An attempt that had already finished its reply is
 * left in the timeline like any other turn output.
 * User messages remain visible because they are inputs to the logical run,
 * including the steer message that started the replacement attempt.
 */
function deriveSupersededAttemptFolds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  unfoldedRunIds: ReadonlySet<RunId>,
  liveSubagentEntryIds: ReadonlySet<string>,
  completeReplyEntryIds: ReadonlySet<string>,
): ReadonlyMap<string, SupersededAttemptFold> {
  const completeAttemptIds = new Set(
    timelineEntries.flatMap((entry) =>
      entry.attempt !== undefined && completeReplyEntryIds.has(entry.id) ? [entry.attempt.id] : [],
    ),
  );
  const entriesByAttemptId = new Map<RunAttemptId, TimelineEntry[]>();
  for (const entry of timelineEntries) {
    if (
      entry.attempt?.status !== "superseded" ||
      completeAttemptIds.has(entry.attempt.id) ||
      unfoldedRunIds.has(entry.attempt.runId) ||
      (entry.kind === "message" && entry.message.role === "user") ||
      // A published page stays visible, as it does when its turn folds.
      entry.kind === "html-render" ||
      entry.kind === "mcp-app" ||
      timelineEntryIsPersistentResourceCard(entry) ||
      // A steer supersedes the attempt but leaves its children running.
      liveSubagentEntryIds.has(entry.id) ||
      (entry.kind === "work" && entry.entry.itemType === "system_notice")
    ) {
      continue;
    }
    const entries = entriesByAttemptId.get(entry.attempt.id) ?? [];
    entries.push(entry);
    entriesByAttemptId.set(entry.attempt.id, entries);
  }

  const foldsByAnchorEntryId = new Map<string, SupersededAttemptFold>();
  for (const entries of entriesByAttemptId.values()) {
    const firstEntry = entries[0];
    const attempt = firstEntry?.attempt;
    if (firstEntry === undefined || attempt === undefined) continue;
    foldsByAnchorEntryId.set(firstEntry.id, {
      runId: attempt.runId,
      attemptId: attempt.id,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds: new Set(entries.map((entry) => entry.id)),
    });
  }
  return foldsByAnchorEntryId;
}

/**
 * The latest turn counts as unsettled while it is still running (or has not
 * recorded a completion). This is deliberately keyed on the turn's own
 * lifecycle rather than transient working state: right after the user sends
 * a message, the previous turn is still the "active" one until the server
 * creates the new turn, and folding must not flicker through that window.
 */
function deriveUnsettledRunId(
  latestRun: TimelineLatestRun | null,
  runningRunId: RunId | null = null,
): RunId | null {
  if (runningRunId !== null) return runningRunId;
  if (!latestRun) {
    return null;
  }
  const isSettled =
    latestRun.completedAt !== null &&
    latestRun.status !== "running" &&
    latestRun.status !== "starting" &&
    latestRun.status !== "waiting";
  return isSettled ? null : latestRun.runId;
}

/**
 * Subagent cards that stay out of their turn's folds. A child can keep working
 * after its launching turn settles (or its attempt is superseded), and the
 * waiting footer counts it, so its card stays visible until the child ends.
 * Adjacent cards from one provider turn render as a single grouped row; the
 * whole group stays visible while any member is live, so a launch batch never
 * shows half of its children.
 */
function liveSubagentCardEntryIds(entries: ReadonlyArray<TimelineEntry>): ReadonlySet<string> {
  const visible = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "event" || entry.projectedItem.item.type !== "subagent") continue;
    if (subagentEntryMembers(entry).some(({ item }) => isLiveSubagentTurnItem(item))) {
      visible.add(entry.id);
    }
  }
  return visible;
}

/** `runlessKey` stands in for the run of entries that have none. */
function timelineEntryFoldRunId(entry: TimelineEntry, runlessKey: RunId | null): RunId | null {
  if (entry.kind === "work" && entry.entry.itemType === "system_notice") return null;
  if (entry.kind === "message" && entry.message.role === "assistant") {
    return entry.message.runId ?? runlessKey;
  }
  if (entry.kind === "work") {
    return entry.entry.runId ?? runlessKey;
  }
  if (
    entry.kind === "event" &&
    (timelineEntryIsPersistentResourceCard(entry) || entry.projectedItem.item.type === "subagent")
  ) {
    return entry.projectedItem.item.runId ?? runlessKey;
  }
  return null;
}

/** A steer adds input to its existing turn, without creating a new header. */
function timelineEntryStartsResponse(entry: TimelineEntry): boolean {
  return (
    (entry.kind === "message" &&
      entry.message.role === "user" &&
      entry.message.inputIntent !== "steer" &&
      entry.message.inputIntent !== "promoted_queued_to_steer") ||
    (entry.kind === "work" && entry.entry.itemType === "notification")
  );
}

function responseBoundaryRunId(entry: TimelineEntry): RunId | null {
  if (entry.kind === "message") return entry.message.runId ?? null;
  if (entry.kind === "work") return entry.entry.runId ?? null;
  return null;
}

/**
 * A promptless provider restart replaces the native turn without adding a
 * user message. Keep every provider turn since the initiating prompt in one
 * visual response until the replacement turn settles. Steers keep that
 * boundary; an automatic wake starts a new response with its notification.
 */
function lastResponseBoundaryIndex(timelineEntries: ReadonlyArray<TimelineEntry>): number {
  return timelineEntries.findLastIndex(timelineEntryStartsResponse);
}

function deriveActiveVisualResponseRunIds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  unsettledRunId: RunId | null;
  isWorking: boolean;
}): ReadonlySet<RunId> {
  const runIds = new Set<RunId>();
  if (input.unsettledRunId === null) {
    return runIds;
  }

  runIds.add(input.unsettledRunId);
  if (!input.isWorking) {
    return runIds;
  }

  const latestResponseBoundaryIndex = lastResponseBoundaryIndex(input.timelineEntries);
  for (
    let index = latestResponseBoundaryIndex + 1;
    index < input.timelineEntries.length;
    index += 1
  ) {
    const runId = timelineEntryRunId(input.timelineEntries[index]!);
    if (runId !== null) {
      runIds.add(runId);
    }
  }
  return runIds;
}

function timelineEntryFailedItem(entry: TimelineEntry) {
  const item =
    entry.kind === "event"
      ? entry.projectedItem.item
      : entry.kind === "work"
        ? entry.entry.projectedItem?.item
        : null;
  return item?.type === "error" && item.status === "failed" && item.parentItemId === null
    ? item
    : null;
}

function failedTimelineRunIds(
  entries: ReadonlyArray<TimelineEntry>,
  latestRun: TimelineLatestRun | null,
) {
  const failed = new Set<RunId>();
  if (latestRun?.status === "failed") failed.add(latestRun.runId);
  for (const entry of entries) {
    const runId = timelineEntryFailedItem(entry)?.runId;
    if (runId) failed.add(runId);
  }
  return failed;
}

/**
 * Settled turns fold activity before their terminal assistant message behind
 * a "Worked for ..." row. Ordinary trailing work joins the fold, while failures
 * and work still in progress stay visible. A prompt without a run (a
 * provider-native subagent, or a turn imported from V1) folds its response
 * the same way.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestRun: TimelineLatestRun | null;
  unfoldedRunIds: ReadonlySet<RunId>;
  /** Keeps the latest runless response open; V2 work must not reopen imported turns. */
  runlessWorkActive: boolean;
  liveSubagentEntryIds: ReadonlySet<string>;
  /** Finished replies a steer superseded; they answer their prompt, so they stay out. */
  completeSupersededReplyEntryIds: ReadonlySet<string>;
}): ReadonlyMap<string, TurnFold> {
  const interruptedRunIds = interruptedTimelineRunIds(input.timelineEntries);
  const promptIndexByRunId = new Map<RunId, number>();
  for (const [index, entry] of input.timelineEntries.entries()) {
    if (timelineEntryStartsResponse(entry)) {
      const runId = responseBoundaryRunId(entry);
      if (runId !== null && !promptIndexByRunId.has(runId)) promptIndexByRunId.set(runId, index);
    }
  }

  interface TurnGroup {
    entries: Array<TimelineEntry>;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    /**
     * The user message or notification that kicked the turn off. Entry timestamps alone
     * undercount the duration (the first entry appears only once the
     * provider starts producing output), and a turn cut short by a steer may
     * hold a single instantaneous commentary message.
     */
    startBoundary: string | null;
    anchorEntryId: string;
  }
  const groupsByRunId = new Map<RunId, TurnGroup>();
  const runlessFailedKeys = new Set<RunId>();

  // Fold state is keyed by run, so each runless prompt lends its response a
  // stable key of its own. Decide per prompt, not per thread: a V1 thread's
  // first V2 run must not unfold every imported turn above it.
  let runlessKey: RunId | null = null;
  let responseKey: RunId | null = null;
  let pendingBoundary: { createdAt: string; anchorEntryId: string } | null = null;
  for (const [index, entry] of input.timelineEntries.entries()) {
    if (timelineEntryStartsResponse(entry)) {
      const nextEntry = input.timelineEntries[index + 1];
      pendingBoundary = nextEntry
        ? { createdAt: entry.createdAt, anchorEntryId: nextEntry.id }
        : null;
      const boundaryRunId = responseBoundaryRunId(entry);
      runlessKey = boundaryRunId == null ? RunId.make(`runless:${entry.id}`) : null;
      responseKey = boundaryRunId ?? runlessKey;
      continue;
    }
    const ownRunId = timelineEntryFoldRunId(entry, runlessKey);
    if (!ownRunId) {
      continue;
    }
    // Resuming a subagent moves its item to the resuming run, but the item
    // keeps its place in the turn that started it. It folds with that turn,
    // so the later run's fold still opens under its own prompt.
    const runId =
      responseKey !== null && (promptIndexByRunId.get(ownRunId) ?? -1) > index
        ? responseKey
        : ownRunId;
    if (runId === runlessKey && timelineEntryFailedItem(entry) !== null) {
      runlessFailedKeys.add(runId);
    }
    let group = groupsByRunId.get(runId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        // Each user boundary starts at most one turn; a second turn after the
        // same user message (e.g. a steer-superseded continuation) falls back
        // to its own first entry.
        startBoundary: pendingBoundary?.createdAt ?? null,
        anchorEntryId: pendingBoundary?.anchorEntryId ?? entry.id,
      };
      pendingBoundary = null;
      groupsByRunId.set(runId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) {
        group.terminalEntry = entry;
      }
      if (entry.message.streaming) {
        group.hasStreamingMessage = true;
      }
    }
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [runId, group] of groupsByRunId) {
    if (
      input.unfoldedRunIds.has(runId) ||
      interruptedRunIds.has(runId) ||
      runlessFailedKeys.has(runId) ||
      (input.runlessWorkActive && runId === runlessKey)
    ) {
      continue;
    }
    if (group.hasStreamingMessage) {
      continue;
    }
    const hiddenEntryIds = new Set<string>();
    const terminalEntryIndex = group.terminalEntry
      ? group.entries.findIndex((entry) => entry.id === group.terminalEntry?.id)
      : group.entries.length;
    for (const [index, entry] of group.entries.entries()) {
      if (entry.id === group.terminalEntry?.id) {
        continue;
      }
      const isCompaction =
        entry.kind === "work" && entry.entry.sourceActivityKind === "context-compaction";
      const isFoldableTrailingActivity =
        (entry.kind === "work" &&
          entry.entry.toolLifecycleStatus !== "inProgress" &&
          !workEntryDisplayIndicatesToolFailure(entry.entry)) ||
        isCutOffAssistantMessage(entry);
      if (!isCompaction && index > terminalEntryIndex && !isFoldableTrailingActivity) {
        continue;
      }
      // Linked resources and still-working children can outlive their
      // launching run and stay visible after the surrounding work folds.
      if (
        timelineEntryIsPersistentResourceCard(entry) ||
        input.liveSubagentEntryIds.has(entry.id) ||
        input.completeSupersededReplyEntryIds.has(entry.id)
      ) {
        continue;
      }
      if (entry.kind === "work" && entry.entry.itemType === "notification") continue;
      hiddenEntryIds.add(entry.id);
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }
    // A lone compaction row stays visible on its own; it only folds away as
    // part of a turn that already folds other work.
    const hidesNonCompactionWork = group.entries.some(
      (entry) =>
        hiddenEntryIds.has(entry.id) &&
        !(entry.kind === "work" && entry.entry.sourceActivityKind === "context-compaction"),
    );
    if (!hidesNonCompactionWork) {
      continue;
    }

    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !lastEntry) {
      continue;
    }

    const isLatestInterruptedTurn =
      input.latestRun?.runId === runId && input.latestRun.status === "interrupted";
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd =
      lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs =
      input.latestRun?.runId === runId && input.latestRun.startedAt && input.latestRun.completedAt
        ? computeElapsedMs(input.latestRun.startedAt, input.latestRun.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    foldsByAnchorEntryId.set(group.anchorEntryId, {
      runId,
      anchorEntryId: group.anchorEntryId,
      createdAt: group.startBoundary ?? firstEntry.createdAt,
      hiddenEntryIds,
      label,
    });
  }
  return foldsByAnchorEntryId;
}

/**
 * When a settled turn ends with tool calls after its terminal text, treat the
 * text and tools as one visual response. The message metadata becomes the
 * footer for the whole block instead of separating the prose from the tools.
 */
function attachTrailingToolGroupsToAssistant(
  rows: ReadonlyArray<MessagesTimelineRow>,
): MessagesTimelineRow[] {
  const messageRowsWithoutMeta = new Set<string>();
  const metaRowsAfterIndex = new Map<
    number,
    Extract<MessagesTimelineRow, { kind: "assistant-meta" }>
  >();

  for (const [messageIndex, row] of rows.entries()) {
    const runId = row.kind === "message" ? (row.message.runId ?? null) : null;
    if (
      row.kind !== "message" ||
      row.message.role !== "assistant" ||
      !row.showAssistantMeta ||
      runId === null
    ) {
      continue;
    }

    let lastTrailingWorkIndex = -1;
    let hasTrailingToolGroup = false;
    for (let index = messageIndex + 1; index < rows.length; index += 1) {
      const candidate = rows[index];
      if (!candidate || candidate.kind === "message") {
        break;
      }
      if (candidate.kind === "work-toggle" && candidate.runId === runId) {
        hasTrailingToolGroup = true;
        lastTrailingWorkIndex = index;
        continue;
      }
      if (
        candidate.kind === "event" &&
        candidate.resourceSummary &&
        candidate.projectedItem.item.runId === runId
      ) {
        hasTrailingToolGroup = true;
        lastTrailingWorkIndex = index;
        continue;
      }
      if (
        candidate.kind === "work" &&
        candidate.groupedEntries.some((entry) => entry.runId === runId)
      ) {
        if (
          !candidate.isExpandedToolGroup &&
          candidate.groupedEntries.some(
            (entry) =>
              workLogEntryIsToolLike(entry) ||
              (entry.projectedItem?.item.type === "error" &&
                entry.projectedItem.item.status === "failed"),
          )
        ) {
          hasTrailingToolGroup = true;
        }
        if (hasTrailingToolGroup) {
          lastTrailingWorkIndex = index;
        }
      }
    }

    if (lastTrailingWorkIndex < 0) {
      continue;
    }

    messageRowsWithoutMeta.add(row.id);
    metaRowsAfterIndex.set(lastTrailingWorkIndex, {
      kind: "assistant-meta",
      id: `assistant-meta:${row.message.id}`,
      ...(row.projectedItem === undefined ? {} : { projectedItem: row.projectedItem }),
      createdAt: rows[lastTrailingWorkIndex]?.createdAt ?? row.message.updatedAt,
      message: row.message,
      showAssistantCopyButton: row.showAssistantCopyButton,
      assistantCopyStreaming: row.assistantCopyStreaming,
    });
  }

  const result: MessagesTimelineRow[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.kind === "message" && messageRowsWithoutMeta.has(row.id)) {
      result.push({ ...row, showAssistantMeta: false, showAssistantCopyButton: false });
    } else {
      result.push(row);
    }
    const metaRow = metaRowsAfterIndex.get(index);
    if (metaRow) {
      result.push(metaRow);
    }
  }
  return result;
}

// Delegation already has a durable child card, which is the delegation's one
// row. Remove its tool row once the returned task ID identifies that child or,
// while a waiting call is still running and has no ID yet, once a child of the
// same run carries its task brief. Each child claims one call, so two pending
// calls with the same brief keep a row until each has its own child.
function withoutSubagentDelegationRows(entries: ReadonlyArray<TimelineEntry>) {
  type Child = { readonly id: string; readonly prompt: string; readonly title: string | null };
  const childrenByRun = new Map<RunId, Child[]>();
  for (const entry of entries) {
    if (entry.kind !== "event" || entry.projectedItem.item.type !== "subagent") continue;
    const item = entry.projectedItem.item;
    if (item.origin !== "app_owned" || item.runId === null) continue;
    const children = childrenByRun.get(item.runId) ?? [];
    children.push({ id: item.subagentId, prompt: item.prompt.trim(), title: item.title ?? null });
    childrenByRun.set(item.runId, children);
  }
  const claimed = new Set<string>();
  return entries.filter((entry) => {
    if (entry.kind !== "work" || workEntryDisplayIndicatesToolFailure(entry.entry)) return true;
    const item = entry.entry.projectedItem?.item ?? entry.entry.structuredPayload;
    if (
      item?.type !== "dynamic_tool" ||
      item.runId === null ||
      (item.status !== "running" && item.status !== "completed") ||
      resolveT3McpToolDefinition(item.toolName)?.summaryAction !== "delegate"
    )
      return true;
    const output = compactDynamicToolOutput(item.output);
    if (output?.isError) return true;
    const children = childrenByRun.get(item.runId) ?? [];
    if (output?.taskId !== undefined) {
      const child = children.find(({ id }) => id === output.taskId);
      if (child) claimed.add(child.id);
      return child === undefined;
    }
    const input = readToolRecord(item.input);
    const task = typeof input.task === "string" ? input.task.trim() : "";
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const child = children.find(
      (candidate) =>
        !claimed.has(candidate.id) &&
        ((task !== "" && (candidate.prompt === task || candidate.prompt.endsWith(`\n\n${task}`))) ||
          (title !== "" && candidate.title === title)),
    );
    if (child === undefined) return true;
    claimed.add(child.id);
    return false;
  });
}

/**
 * Every subagent a turn launched, keyed by its first card. Later cards of the
 * same run leave the entry stream, so a turn's spawns, native or delegated,
 * read as one grouped row where the first was launched, and the work around
 * them stays one run of rows.
 */
const subagentBatchMembers = new WeakMap<TimelineEntry, OrchestrationV2ProjectedTurnItem[]>();

function subagentBatchKey(item: OrchestrationV2TurnItem): string | null {
  if (item.runId !== null) return `run:${item.runId}`;
  return item.providerTurnId ? `turn:${item.providerTurnId}` : null;
}

function withTurnSubagentsGrouped(entries: ReadonlyArray<TimelineEntry>): TimelineEntry[] {
  const firstByKey = new Map<string, TimelineEntry>();
  const result: TimelineEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "event" || entry.projectedItem.item.type !== "subagent") {
      result.push(entry);
      continue;
    }
    const key = subagentBatchKey(entry.projectedItem.item);
    const first = key === null ? undefined : firstByKey.get(key);
    if (first !== undefined) {
      subagentBatchMembers.get(first)?.push(entry.projectedItem);
      continue;
    }
    if (key !== null) firstByKey.set(key, entry);
    subagentBatchMembers.set(entry, [entry.projectedItem]);
    result.push(entry);
  }
  return result;
}

/** The cards a subagent entry stands for: itself, or its whole turn's batch. */
function subagentEntryMembers(
  entry: TimelineEntry,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> {
  if (entry.kind !== "event") return [];
  return subagentBatchMembers.get(entry) ?? [entry.projectedItem];
}

const supersededReasoningEntries = new WeakMap<TimelineEntry, TimelineEntry>();

/** A steer or subsequent activity ends thinking even if the provider omits its completion. */
function settleSupersededReasoning(entries: ReadonlyArray<TimelineEntry>) {
  return entries.map((entry, index) => {
    if (
      index === entries.length - 1 ||
      entry.kind !== "work" ||
      entry.entry.itemType !== "reasoning" ||
      entry.entry.toolLifecycleStatus !== "inProgress"
    ) {
      return entry;
    }
    let settled = supersededReasoningEntries.get(entry);
    if (!settled) {
      settled = { ...entry, entry: { ...entry.entry, toolLifecycleStatus: "completed" } };
      supersededReasoningEntries.set(entry, settled);
    }
    return settled;
  });
}

function timelineRowEntries(entries: ReadonlyArray<TimelineEntry>) {
  return withTurnSubagentsGrouped(
    withoutSubagentDelegationRows(settleSupersededReasoning(entries)),
  );
}

/** The turn folds the timeline would draw, before applying expansion state. */
function deriveTimelineTurnFolds(
  input: Pick<
    MessagesTimelineRowsInput,
    "timelineEntries" | "latestRun" | "isWorking" | "runlessWorkActive" | "runningRunId"
  >,
) {
  const timelineEntries = timelineRowEntries(input.timelineEntries);
  const unsettledRunId = deriveUnsettledRunId(input.latestRun ?? null, input.runningRunId ?? null);
  const failedRunIds = failedTimelineRunIds(timelineEntries, input.latestRun ?? null);
  const activeVisualResponseRunIds = deriveActiveVisualResponseRunIds({
    timelineEntries,
    unsettledRunId,
    isWorking: input.isWorking,
  });
  return deriveTurnFolds({
    timelineEntries,
    terminalAssistantMessageIds: deriveTerminalAssistantMessageIds(
      timelineEntries,
      new Set([...interruptedTimelineRunIds(timelineEntries), ...failedRunIds]),
    ),
    latestRun: input.latestRun ?? null,
    unfoldedRunIds: new Set([...activeVisualResponseRunIds, ...failedRunIds]),
    runlessWorkActive: input.isWorking && input.runlessWorkActive === true,
    liveSubagentEntryIds: liveSubagentCardEntryIds(timelineEntries),
    completeSupersededReplyEntryIds: completeSupersededReplyEntryIds(timelineEntries),
  });
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestRun?: TimelineLatestRun | null;
  runningRunId?: RunId | null;
  expandedRunIds?: ReadonlySet<RunId>;
  expandedAttemptIds?: ReadonlySet<RunAttemptId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  /**
   * Groups the user just collapsed. Their headers read collapsed while the
   * details row stays until its close animation ends.
   */
  closingWorkGroupIds?: ReadonlySet<string>;
  /**
   * Turn and attempt folds the user just collapsed, by fold row id. Their rows
   * read collapsed while the revealed rows stay until they animate out.
   */
  closingFoldIds?: ReadonlySet<string>;
  isWorking: boolean;
  /**
   * The live work has no app run (a provider-native subagent thread), so
   * runless entries are the current response instead of settled history.
   */
  runlessWorkActive?: boolean;
  activeTurnStartedAt?: string | null;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  supportsConversationRollback: boolean;
  /** Task ids of subagents still working, used by the active tool indicator. */
  liveAgentTaskIds?: ReadonlySet<string> | undefined;
  /** Live bootstrap progress. Renders a stage card under the first user message. */
  worktreeSetup?: WorktreeSetupSnapshot | null;
}): MessagesTimelineRow[] {
  const timelineEntries = timelineRowEntries(input.timelineEntries);
  const workGroupDisclosure = (groupId: string) => {
    const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
    const closing = !expanded && (input.closingWorkGroupIds?.has(groupId) ?? false);
    return { expanded, ...(closing ? { closing: true } : {}) };
  };
  const turnDiffSummaryByAssistantMessageId = new Map<MessageId, TurnDiffSummary>();
  for (const summary of input.turnDiffSummaries) {
    if (summary.assistantMessageId) {
      turnDiffSummaryByAssistantMessageId.set(summary.assistantMessageId, summary);
    }
  }
  const revertTurnCountByUserMessageId = input.supportsConversationRollback
    ? deriveRevertTurnCountByUserMessageId({
        timelineEntries: timelineEntries,
        checkpoints: input.turnDiffSummaries,
      })
    : new Map<MessageId, number>();
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const unsettledRunId = deriveUnsettledRunId(input.latestRun ?? null, input.runningRunId ?? null);
  const failedRunIds = failedTimelineRunIds(timelineEntries, input.latestRun ?? null);
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(
    timelineEntries,
    new Set([...interruptedTimelineRunIds(timelineEntries), ...failedRunIds]),
  );
  const liveSubagentEntryIds = liveSubagentCardEntryIds(timelineEntries);
  const completeSupersededReplyIds = completeSupersededReplyEntryIds(timelineEntries);
  const supersededFoldsByAnchorEntryId = deriveSupersededAttemptFolds(
    timelineEntries,
    failedRunIds,
    liveSubagentEntryIds,
    completeSupersededReplyIds,
  );
  const activeVisualResponseRunIds = deriveActiveVisualResponseRunIds({
    timelineEntries: timelineEntries,
    unsettledRunId,
    isWorking: input.isWorking,
  });
  const runlessWorkActive = input.isWorking && input.runlessWorkActive === true;
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: timelineEntries,
    terminalAssistantMessageIds,
    latestRun: input.latestRun ?? null,
    unfoldedRunIds: new Set([...activeVisualResponseRunIds, ...failedRunIds]),
    runlessWorkActive,
    liveSubagentEntryIds,
    completeSupersededReplyEntryIds: completeSupersededReplyIds,
  });
  // Entries an open (or closing) fold reveals, by the fold that owns them. The
  // outer turn fold wins over an attempt fold nested inside it.
  const revealedFoldByEntryId = new Map<string, NonNullable<MessagesTimelineRow["foldReveal"]>>();
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    const foldId = turnFoldRowId(fold.runId);
    const expanded = input.expandedRunIds?.has(fold.runId) ?? false;
    const closing = !expanded && (input.closingFoldIds?.has(foldId) ?? false);
    for (const entryId of fold.hiddenEntryIds) {
      if (expanded || closing) revealedFoldByEntryId.set(entryId, { foldId, closing });
      else collapsedEntryIds.add(entryId);
    }
  }
  const collapsedSupersededEntryIds = new Set<string>();
  for (const fold of supersededFoldsByAnchorEntryId.values()) {
    const foldId = attemptFoldRowId(fold.attemptId);
    const expanded = input.expandedAttemptIds?.has(fold.attemptId) ?? false;
    const closing = !expanded && (input.closingFoldIds?.has(foldId) ?? false);
    for (const entryId of fold.hiddenEntryIds) {
      if (!expanded && !closing) collapsedSupersededEntryIds.add(entryId);
      else if (!revealedFoldByEntryId.has(entryId)) {
        revealedFoldByEntryId.set(entryId, { foldId, closing });
      }
    }
  }
  const runIdIsActiveResponse = (runId: RunId | null | undefined) =>
    runId == null ? runlessWorkActive : activeVisualResponseRunIds.has(runId);
  const workEntryIsInActiveRun = (entry: WorkLogEntry) =>
    input.isWorking &&
    entry.toolLifecycleStatus === "inProgress" &&
    (entry.runId == null ? runlessWorkActive : entry.runId === unsettledRunId);

  // A steer continues the current turn. Keep its elapsed-time header below
  // the initiating prompt (or automatic wake), rather than moving it down.
  const activeTurnHeaderIndex = input.isWorking
    ? lastResponseBoundaryIndex(timelineEntries) + 1
    : timelineEntries.length;
  // A turn that so far is only reply text has no work for the elapsed-time
  // header to summarize, and settling would drop it from above the reply.
  // The reply takes the header's place as soon as it arrives instead.
  const activeTurnIsReplyOnly =
    activeTurnHeaderIndex < timelineEntries.length &&
    timelineEntries
      .slice(activeTurnHeaderIndex)
      .every((entry) => entry.kind === "message" && entry.message.role === "assistant");

  // Contiguous trailing work entries of the active run collapse into one live
  // row that survives between actions: while a tool runs it shows that tool,
  // and once everything settles it keeps the latest tool in past tense
  // instead of vanishing (#8984).
  const activeToolEntries: Array<Extract<TimelineEntry, { kind: "work" }>> = [];
  if (input.isWorking && (unsettledRunId !== null || runlessWorkActive)) {
    let tailAttemptId: string | null | undefined;
    for (let index = timelineEntries.length - 1; index >= activeTurnHeaderIndex; index -= 1) {
      const entry = timelineEntries[index]!;
      if (
        entry.kind !== "work" ||
        entry.entry.tone === "error" ||
        entry.entry.sourceActivityKind === "runtime.error" ||
        entry.entry.itemType === "system_notice" ||
        entry.entry.itemType === "notification" ||
        !runIdIsActiveResponse(entry.entry.runId) ||
        entry.entry.sourceActivityKind === "context-compaction" ||
        collapsedEntryIds.has(entry.id) ||
        collapsedSupersededEntryIds.has(entry.id) ||
        foldsByAnchorEntryId.has(entry.id) ||
        supersededFoldsByAnchorEntryId.has(entry.id)
      ) {
        break;
      }
      if (tailAttemptId === undefined) {
        tailAttemptId = entry.attempt?.id ?? null;
      } else if ((entry.attempt?.id ?? null) !== tailAttemptId) {
        break;
      }
      activeToolEntries.push(entry);
    }
  }
  activeToolEntries.reverse();
  const visibleActiveToolEntries = activeToolEntries.filter((entry) =>
    workEntryIsVisibleInGroup(entry.entry, true),
  );
  const activeWorkAnchor = activeToolEntries[0];
  const latestVisibleToolEntry = visibleActiveToolEntries.at(-1);
  const latestRunningToolEntry = visibleActiveToolEntries.findLast((entry) =>
    workEntryIsActiveTurnActivity(entry.entry),
  );
  const latestToolKeepsActivityLive =
    latestRunningToolEntry !== undefined ||
    (latestVisibleToolEntry !== undefined &&
      workEntryIndicatesToolSuccess(latestVisibleToolEntry.entry));
  const latestToolFailed =
    latestRunningToolEntry === undefined &&
    latestVisibleToolEntry !== undefined &&
    latestVisibleToolEntry.entry.toolLifecycleStatus !== "declined" &&
    workEntryDisplayIndicatesToolFailure(latestVisibleToolEntry.entry);

  const latestThoughtEntry = visibleActiveToolEntries.findLast(
    (entry) => entry.entry.itemType === "reasoning" && (entry.entry.detail?.trim() ?? "") !== "",
  );
  const activeWorkPlacementEntryId = latestVisibleToolEntry?.id;
  const activeWorkRow =
    activeWorkAnchor && latestVisibleToolEntry && !latestToolFailed
      ? (() => {
          const groupId = workGroupId(activeWorkAnchor.id);
          return {
            kind: "work-live" as const,
            ...workGroupDisclosure(groupId),
            id: latestToolKeepsActivityLive
              ? LIVE_ACTIVITY_ROW_ID
              : `work-live:${activeWorkAnchor.id}`,
            createdAt: activeWorkAnchor.createdAt,
            entry: (latestRunningToolEntry ?? latestVisibleToolEntry).entry,
            groupedEntries: visibleActiveToolEntries.map((entry) => entry.entry),
            groupId,
            active: latestToolKeepsActivityLive,
            ...(latestThoughtEntry ? { thought: latestThoughtEntry.entry } : {}),
          };
        })()
      : null;
  const activeWorkEntryIds = new Set(
    activeWorkRow !== null || latestToolFailed ? activeToolEntries.map((entry) => entry.id) : [],
  );
  const appendWorkingRow = () => {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt ?? null,
    });
  };
  let hasActivityRow = false;
  let hasActiveCompaction = false;
  const appendActiveWorkRows = () => {
    if (activeWorkRow === null) return;
    nextRows.push(activeWorkRow);
    hasActivityRow ||= activeWorkRow.active;
    if (!activeWorkRow.expanded && !activeWorkRow.closing) return;
    nextRows.push(
      expandedWorkGroupRow(
        activeWorkRow.groupId,
        activeWorkRow.createdAt,
        activeWorkRow.groupedEntries,
        activeWorkRow.closing === true,
      ),
    );
  };

  // Rows pushed for a revealed entry, marked once the entry's turn is done
  // (its branches `continue` from many places).
  let pendingReveal: {
    start: number;
    reveal: NonNullable<MessagesTimelineRow["foldReveal"]>;
  } | null = null;
  const flushPendingReveal = () => {
    if (pendingReveal === null) return;
    for (let rowIndex = pendingReveal.start; rowIndex < nextRows.length; rowIndex += 1) {
      nextRows[rowIndex] = { ...nextRows[rowIndex]!, foldReveal: pendingReveal.reveal };
    }
    pendingReveal = null;
  };

  for (let index = 0; index < timelineEntries.length; index += 1) {
    flushPendingReveal();
    const timelineEntry = timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (input.isWorking && index === activeTurnHeaderIndex && !activeTurnIsReplyOnly) {
      appendWorkingRow();
    }

    if (timelineEntry.id === activeWorkPlacementEntryId) {
      appendActiveWorkRows();
    }

    // The terminal interrupt result is the useful timeline marker. The
    // preceding request is transient bookkeeping and duplicates that marker.
    if (
      timelineEntry.kind === "event" &&
      timelineEntry.projectedItem.item.type === "run_interrupt_request"
    ) {
      continue;
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: turnFoldRowId(turnFold.runId),
        createdAt: turnFold.createdAt,
        runId: turnFold.runId,
        label: turnFold.label,
        expanded: input.expandedRunIds?.has(turnFold.runId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    const reveal = revealedFoldByEntryId.get(timelineEntry.id);
    if (reveal?.foldId.startsWith("turn-fold:")) {
      pendingReveal = { start: nextRows.length, reveal };
    }

    const supersededFold = supersededFoldsByAnchorEntryId.get(timelineEntry.id);
    if (supersededFold) {
      nextRows.push({
        kind: "attempt-fold",
        id: attemptFoldRowId(supersededFold.attemptId),
        createdAt: supersededFold.createdAt,
        runId: supersededFold.runId,
        attemptId: supersededFold.attemptId,
        label: "Superseded attempt",
        expanded: input.expandedAttemptIds?.has(supersededFold.attemptId) ?? false,
      });
    }

    if (collapsedSupersededEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (reveal && pendingReveal === null) {
      pendingReveal = { start: nextRows.length, reveal };
    }

    if (activeWorkEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (
      timelineEntry.kind === "work" &&
      timelineEntry.entry.sourceActivityKind === "context-compaction"
    ) {
      const active = workEntryIsInActiveRun(timelineEntry.entry);
      hasActiveCompaction ||= active;
      nextRows.push({
        kind: "context-compaction",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        label: timelineEntry.entry.label,
        active,
      });
      continue;
    }

    if (timelineEntry.kind === "work") {
      if (
        (timelineEntry.entry.runId != null && failedRunIds.has(timelineEntry.entry.runId)) ||
        (timelineEntry.entry.itemType === "error" &&
          timelineEntry.entry.toolLifecycleStatus === "failed") ||
        timelineEntry.entry.tone === "error" ||
        timelineEntry.entry.sourceActivityKind === "runtime.error" ||
        timelineEntry.entry.itemType === "system_notice" ||
        timelineEntry.entry.itemType === "notification"
      ) {
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries: [timelineEntry.entry],
          isExpandedToolGroup: false,
        });
        continue;
      }
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < timelineEntries.length) {
        const nextEntry = timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          nextEntry.entry.sourceActivityKind === "context-compaction" ||
          nextEntry.entry.tone === "error" ||
          nextEntry.entry.sourceActivityKind === "runtime.error" ||
          nextEntry.entry.itemType === "system_notice" ||
          nextEntry.entry.itemType === "notification" ||
          activeWorkEntryIds.has(nextEntry.id) ||
          collapsedEntryIds.has(nextEntry.id) ||
          collapsedSupersededEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id) ||
          supersededFoldsByAnchorEntryId.has(nextEntry.id) ||
          (nextEntry.entry.runId ?? null) !== (timelineEntry.entry.runId ?? null) ||
          nextEntry.attempt?.id !== timelineEntry.attempt?.id
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = groupedEntries.filter((entry) =>
        workEntryIsVisibleInGroup(entry, workEntryIsInActiveRun(entry)),
      );
      if (visibleGroupedEntries.length > 0) {
        const activeInProgressToolEntries = visibleGroupedEntries.filter(workEntryIsInActiveRun);
        if (activeInProgressToolEntries.length > 0) {
          const groupId = workGroupId(timelineEntry.id);
          const disclosure = workGroupDisclosure(groupId);
          const latestActiveToolEntry = activeInProgressToolEntries.at(-1)!;
          nextRows.push({
            kind: "work-live",
            id: `work-live:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            entry: latestActiveToolEntry,
            groupedEntries: visibleGroupedEntries,
            groupId,
            ...disclosure,
            active: true,
          });
          hasActivityRow = true;
          if (disclosure.expanded || disclosure.closing) {
            nextRows.push(
              expandedWorkGroupRow(
                groupId,
                timelineEntry.createdAt,
                visibleGroupedEntries,
                disclosure.closing === true,
              ),
            );
          }
        } else if (
          visibleGroupedEntries.length === 1 &&
          workLogEntryIsToolLike(visibleGroupedEntries[0]!)
        ) {
          const singleEntry = visibleGroupedEntries[0]!;
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
            isExpandedToolGroup: false,
            displayLabel: workEntryLabel(singleEntry, "completed"),
          });
        } else {
          const groupId = workGroupId(timelineEntry.id);
          const disclosure = workGroupDisclosure(groupId);
          const primarySourceEntry = visibleGroupedEntries.find(
            (entry) => entry.toolSource !== undefined,
          );
          const primarySourceKey = primarySourceEntry?.toolSource?.key;
          const primarySourceIcon = primarySourceKey
            ? (visibleGroupedEntries.find(
                (entry) =>
                  entry.toolSource?.key === primarySourceKey && entry.toolIcon !== undefined,
              )?.toolIcon ?? primarySourceEntry?.toolSource?.icon)
            : undefined;
          const groupToolIcon =
            primarySourceIcon ??
            visibleGroupedEntries.findLast((entry) => entry.toolIcon !== undefined)?.toolIcon;
          const latestToolEntry = visibleGroupedEntries.findLast(workLogEntryIsToolLike);
          const singleEntry =
            visibleGroupedEntries.length === 1 ? (visibleGroupedEntries[0] ?? null) : null;
          nextRows.push({
            kind: "work-toggle",
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            runId: timelineEntry.entry.runId ?? null,
            groupId,
            hiddenCount: visibleGroupedEntries.length,
            ...disclosure,
            summary:
              singleEntry !== null
                ? workEntryLabel(singleEntry, "completed")
                : summarizeToolGroup(visibleGroupedEntries).summary,
            summaryIcon: toolGroupIcon(visibleGroupedEntries) ?? "wrench",
            ...(groupToolIcon ? { toolIcon: groupToolIcon } : {}),
            hasFailure:
              latestToolEntry !== undefined &&
              workEntryDisplayIndicatesToolFailure(latestToolEntry),
          });
          if (disclosure.expanded || disclosure.closing) {
            nextRows.push(
              expandedWorkGroupRow(
                groupId,
                timelineEntry.createdAt,
                visibleGroupedEntries,
                disclosure.closing === true,
              ),
            );
          }
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "html-render") {
      nextRows.push({
        kind: "html-render",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        htmlRender: timelineEntry.htmlRender,
      });
      continue;
    }

    if (timelineEntry.kind === "mcp-app") {
      nextRows.push({
        kind: "mcp-app",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        sourceThreadId: timelineEntry.sourceThreadId,
        itemId: timelineEntry.itemId,
        revision: timelineEntry.revision,
        mcpApp: timelineEntry.mcpApp,
      });
      continue;
    }

    if (timelineEntry.kind === "event") {
      const members = subagentEntryMembers(timelineEntry);
      if (timelineEntry.projectedItem.item.type === "subagent" && members.length > 1) {
        nextRows.push({
          kind: "event",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          projectedItem: timelineEntry.projectedItem,
          subagents: [...members],
        });
        continue;
      }
      nextRows.push({
        kind: "event",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        projectedItem: timelineEntry.projectedItem,
      });
      continue;
    }

    const assistantResponseStillInProgress =
      timelineEntry.message.role === "assistant" &&
      runIdIsActiveResponse(timelineEntry.message.runId);

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantResponseStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      ...(timelineEntry.projectedItem === undefined
        ? {}
        : { projectedItem: timelineEntry.projectedItem }),
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantResponseStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }
  flushPendingReveal();

  // Until the agent's turn is live, the setup card sits under the send with
  // the working header above it (the header reads "Setting up worktree…" and
  // later swaps its text in place, so nothing moves at the handoff). "Live"
  // means the turn is in the timeline, not just that the server dispatched
  // it: the card must not vanish in the gap between. Once the turn is live
  // the stage list leaves the timeline; a script that is still running is
  // surfaced by the working header itself. A failed or cancelled setup stays
  // under the send so its outcome and actions remain reachable.
  const setupHandedOff =
    input.worktreeSetup !== null &&
    input.worktreeSetup !== undefined &&
    worktreeSetupAgentStarted(input.worktreeSetup) &&
    input.latestRun?.startedAt != null;
  // A finished setup keeps the slot until the turn is live, so the card does
  // not jump above the working header in the gap before the run starts.
  const setupOwnsWorkingSlot =
    !setupHandedOff &&
    (input.worktreeSetup?.phase === "running" || input.worktreeSetup?.phase === "done");
  if (input.worktreeSetup && (!setupHandedOff || input.worktreeSetup.phase !== "running")) {
    const setupRow = {
      kind: "worktree-setup",
      id: WORKTREE_SETUP_ROW_ID,
      createdAt: input.worktreeSetup.startedAt,
      snapshot: input.worktreeSetup,
      embedded: setupHandedOff,
    } as const;
    const firstUserRowIndex = nextRows.findIndex(
      (row) => row.kind === "message" && row.message.role === "user",
    );
    // While the setup runs, the working header leads the card in the same
    // slot it keeps once the agent's own turn takes over. The main pass may
    // already have placed that header (a bootstrap counts as working).
    const workingRowIndex = setupOwnsWorkingSlot
      ? nextRows.findIndex((row) => row.kind === "working")
      : -1;
    if (workingRowIndex >= 0) {
      nextRows.splice(workingRowIndex + 1, 0, setupRow);
    } else {
      const insertAt = firstUserRowIndex >= 0 ? firstUserRowIndex + 1 : nextRows.length;
      nextRows.splice(
        insertAt,
        0,
        ...(setupOwnsWorkingSlot
          ? [
              {
                kind: "working",
                id: "working-indicator-row",
                createdAt: input.worktreeSetup.startedAt,
              } as const,
              setupRow,
            ]
          : [setupRow]),
      );
    }
  }

  // A setup that owns the working slot sits under it and shows no activity
  // row of its own; every other state gets the usual tail.
  const hasWorkingRow = nextRows.some((row) => row.kind === "working");
  if (input.isWorking && !hasWorkingRow && activeTurnHeaderIndex === timelineEntries.length) {
    appendWorkingRow();
  }
  if (
    input.isWorking &&
    !setupOwnsWorkingSlot &&
    !hasActiveCompaction &&
    (!hasActivityRow || latestToolFailed)
  ) {
    // A failed latest tool hands the row back to thinking, but its group
    // stays reachable through the same disclosure the live row offers.
    const failedGroupAnchor = latestToolFailed ? activeWorkAnchor : undefined;
    if (failedGroupAnchor) {
      const groupId = workGroupId(failedGroupAnchor.id);
      const disclosure = workGroupDisclosure(groupId);
      nextRows.push({
        kind: "thinking",
        id: LIVE_ACTIVITY_ROW_ID,
        createdAt: input.activeTurnStartedAt ?? null,
        groupId,
        ...disclosure,
      });
      if (disclosure.expanded || disclosure.closing) {
        nextRows.push(
          expandedWorkGroupRow(
            groupId,
            failedGroupAnchor.createdAt,
            visibleActiveToolEntries.map((entry) => entry.entry),
            disclosure.closing === true,
          ),
        );
      }
    } else {
      const lastRow = nextRows.at(-1);
      if (
        lastRow?.kind === "message" &&
        lastRow.message.role === "assistant" &&
        runIdIsActiveResponse(lastRow.message.runId)
      ) {
        // Under the reply it is working on, the activity holds the slot its
        // metadata row takes once the turn settles.
        nextRows[nextRows.length - 1] = { ...lastRow, showLiveActivity: true };
      } else {
        nextRows.push({
          kind: "thinking",
          id: LIVE_ACTIVITY_ROW_ID,
          createdAt: input.activeTurnStartedAt ?? null,
        });
      }
    }
  }

  const result = attachTrailingToolGroupsToAssistant(
    collapseRestartMarkers(attachCreatedThreadSummaries(nextRows, timelineEntries)),
  );
  return result.map((row, index) =>
    timelineRowIsWorkLog(row) && timelineRowIsWorkLog(result[index + 1])
      ? { ...row, continuesWorkLog: true }
      : row,
  );
}

export interface TimelineRestart {
  readonly at: string;
  readonly summary: string;
}

/** A server restart notice, such as "Cogenly restarted and resumed this turn". */
function workEntryRestart(entry: WorkLogEntry): TimelineRestart | null {
  const item = entry.structuredPayload;
  if (item?.type !== "notification" || item.source.kind !== "system") return null;
  return /\brestarted\b/i.test(item.summary)
    ? { at: entry.createdAt, summary: item.summary }
    : null;
}

/** Quiet lifecycle rows a run of restart notices can span without splitting. */
function timelineRowIsSystemMarker(row: MessagesTimelineRow): boolean {
  return (
    row.kind === "restart-divider" ||
    row.kind === "context-compaction" ||
    (row.kind === "work" &&
      row.groupedEntries.every(
        (entry) => entry.itemType === "notification" || entry.itemType === "system_notice",
      ))
  );
}

/**
 * Turns restart notices into divider rows and folds repeats into one: a
 * restart directly after another, or separated only by other system notices,
 * joins the earlier divider instead of adding a row.
 */
export function collapseRestartMarkers(
  rows: ReadonlyArray<MessagesTimelineRow>,
): MessagesTimelineRow[] {
  const result: MessagesTimelineRow[] = [];
  for (const row of rows) {
    const entry =
      row.kind === "work" && !row.isExpandedToolGroup && row.groupedEntries.length === 1
        ? row.groupedEntries[0]
        : undefined;
    const restart = entry ? workEntryRestart(entry) : null;
    if (!restart) {
      result.push(row);
      continue;
    }
    let index = result.length - 1;
    while (index >= 0) {
      const candidate = result[index]!;
      if (candidate.kind === "restart-divider" || !timelineRowIsSystemMarker(candidate)) break;
      index -= 1;
    }
    const previous = result[index];
    if (previous?.kind === "restart-divider") {
      result[index] = { ...previous, restarts: [...previous.restarts, restart] };
      continue;
    }
    result.push({
      kind: "restart-divider",
      id: row.id,
      createdAt: restart.at,
      restarts: [restart],
    });
  }
  return result;
}

/** Adjacent work stays one visual list even when virtualization splits its groups. */
function timelineRowIsWorkLog(row: MessagesTimelineRow | undefined): boolean {
  return (
    row !== undefined &&
    (row.kind === "work" ||
      row.kind === "work-toggle" ||
      row.kind === "work-live" ||
      row.kind === "thinking")
  );
}

// Keep created chats below the final answer even when the work that created them folds away.
function attachCreatedThreadSummaries(
  rows: MessagesTimelineRow[],
  timelineEntries: ReadonlyArray<TimelineEntry>,
): MessagesTimelineRow[] {
  const terminalIndexes = new Map<RunId, number>();
  const collapsedRuns = new Set<RunId>();
  const createdByRun = new Map<RunId, Array<Extract<MessagesTimelineRow, { kind: "event" }>>>();
  for (const [index, row] of rows.entries()) {
    if (row.kind === "message" && row.showAssistantMeta && row.message.runId) {
      terminalIndexes.set(row.message.runId, index);
    }
    if (row.kind === "turn-fold" && !row.expanded) collapsedRuns.add(row.runId);
  }
  for (const entry of timelineEntries) {
    const projectedItem =
      entry.kind === "work"
        ? entry.entry.projectedItem
        : entry.kind === "event"
          ? entry.projectedItem
          : undefined;
    if (projectedItem?.item.type === "thread_created" && projectedItem.item.runId) {
      const runId = projectedItem.item.runId;
      const entries = createdByRun.get(runId) ?? [];
      entries.push({ kind: "event", id: entry.id, createdAt: entry.createdAt, projectedItem });
      createdByRun.set(runId, entries);
    }
  }
  return rows.flatMap((row, index): MessagesTimelineRow[] => {
    if (row.kind === "event" && row.projectedItem.item.type === "thread_created") {
      const runId = row.projectedItem.item.runId;
      const terminalIndex = runId === null ? undefined : terminalIndexes.get(runId);
      if (terminalIndex !== undefined && (collapsedRuns.has(runId!) || index > terminalIndex))
        return [];
    }
    if (row.kind === "message" && row.showAssistantMeta && row.message.runId) {
      return [
        row,
        ...(createdByRun.get(row.message.runId) ?? []).map((entry) => ({
          ...entry,
          id: `summary:${entry.id}`,
          resourceSummary: true,
        })),
      ];
    }
    return [row];
  });
}

const WORKTREE_SETUP_ROW_ID = "worktree-setup-row";

type MessagesTimelineRowsInput = Parameters<typeof deriveMessagesTimelineRows>[0];

export interface MessagesTimelineRowsProjection {
  readonly input: MessagesTimelineRowsInput;
  readonly rows: MessagesTimelineRow[];
}

/**
 * The turn fold that holds an entry, keyed as `expandedRunIds` expects. Runless
 * (imported V1) turns fold under a synthetic key, so the entry's own run id is
 * not enough to open them.
 */
export function timelineEntryTurnFoldRunId(
  input: Pick<
    MessagesTimelineRowsInput,
    "timelineEntries" | "latestRun" | "isWorking" | "runlessWorkActive" | "runningRunId"
  >,
  entryId: string,
): RunId | null {
  return timelineTurnFoldRunIdsByEntryId(input).get(entryId) ?? null;
}

/** Every folded entry's fold key, computed once for callers that check many entries. */
export function timelineTurnFoldRunIdsByEntryId(
  input: Pick<
    MessagesTimelineRowsInput,
    "timelineEntries" | "latestRun" | "isWorking" | "runlessWorkActive" | "runningRunId"
  >,
): ReadonlyMap<string, RunId> {
  const byEntryId = new Map<string, RunId>();
  for (const fold of deriveTimelineTurnFolds(input).values()) {
    for (const entryId of fold.hiddenEntryIds) byEntryId.set(entryId, fold.runId);
  }
  return byEntryId;
}

function sameCheckpointSummaries(
  previous: MessagesTimelineRowsInput["turnDiffSummaries"],
  next: MessagesTimelineRowsInput["turnDiffSummaries"],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (const [index, summary] of previous.entries()) {
    if (!shallow(summary, next[index])) return false;
  }
  return true;
}

function replaceStreamingMessageRows(
  input: MessagesTimelineRowsInput,
  previous: MessagesTimelineRowsProjection,
): MessagesTimelineRow[] | null {
  const {
    timelineEntries: previousEntries,
    latestRun: previousRun,
    turnDiffSummaries: previousCheckpoints,
    expandedRunIds: previousExpandedRuns,
    expandedAttemptIds: previousExpandedAttempts,
    expandedWorkGroupIds: previousExpandedGroups,
    ...previousContext
  } = previous.input;
  const {
    timelineEntries,
    latestRun,
    turnDiffSummaries,
    expandedRunIds,
    expandedAttemptIds,
    expandedWorkGroupIds,
    ...context
  } = input;
  // V2 shell and checkpoint selectors produce fresh summaries for each event.
  // Equivalent summaries must not invalidate a text-only projection.
  if (
    timelineEntries.length !== previousEntries.length ||
    !shallow(previousContext, context) ||
    !shallow(previousRun, latestRun) ||
    !shallow(previousExpandedRuns, expandedRunIds) ||
    !shallow(previousExpandedAttempts, expandedAttemptIds) ||
    !shallow(previousExpandedGroups, expandedWorkGroupIds) ||
    !sameCheckpointSummaries(previousCheckpoints, turnDiffSummaries)
  ) {
    return null;
  }
  const replacements = new Map<ChatMessage, Extract<TimelineEntry, { kind: "message" }>>();
  for (const [index, entry] of timelineEntries.entries()) {
    const previousEntry = previousEntries[index]!;
    if (entry === previousEntry) continue;
    if (
      entry.kind !== "message" ||
      previousEntry.kind !== "message" ||
      entry.id !== previousEntry.id ||
      entry.createdAt !== previousEntry.createdAt ||
      entry.attempt !== previousEntry.attempt
    ) {
      return null;
    }
    if (
      entry.projectedItem !== previousEntry.projectedItem &&
      (entry.projectedItem === undefined ||
        previousEntry.projectedItem === undefined ||
        !isStreamingTurnItemTextUpdate(previousEntry.projectedItem, entry.projectedItem))
    ) {
      return null;
    }
    if (
      entry.message === previousEntry.message &&
      entry.projectedItem === previousEntry.projectedItem
    )
      continue;
    if (!isStreamingMessageTextUpdate(previousEntry.message, entry.message)) return null;
    replacements.set(previousEntry.message, entry);
  }
  if (replacements.size === 0) return previous.rows;
  return previous.rows.map((row) => {
    if (row.kind !== "message" && row.kind !== "assistant-meta") return row;
    const entry = replacements.get(row.message);
    return entry
      ? {
          ...row,
          message: entry.message,
          ...(entry.projectedItem === undefined ? {} : { projectedItem: entry.projectedItem }),
        }
      : row;
  });
}

/** Keep one projection per timeline. Reuse rows only when streaming content changes. */
export function deriveMessagesTimelineRowsWithState(
  input: MessagesTimelineRowsInput,
  previous: MessagesTimelineRowsProjection | null = null,
): MessagesTimelineRowsProjection {
  return {
    input,
    rows:
      (previous === null ? null : replaceStreamingMessageRows(input, previous)) ??
      deriveMessagesTimelineRows(input),
  };
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;
  if (
    a.foldReveal?.foldId !== b.foldReveal?.foldId ||
    a.foldReveal?.closing !== b.foldReveal?.closing
  ) {
    return false;
  }

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt;
    case "thinking": {
      const bt = b as typeof a;
      return (
        a.createdAt === bt.createdAt &&
        a.groupId === bt.groupId &&
        a.expanded === bt.expanded &&
        a.closing === bt.closing
      );
    }
    case "worktree-setup":
      return a.snapshot === (b as typeof a).snapshot;

    case "assistant-meta": {
      const bm = b as typeof a;
      return (
        a.createdAt === bm.createdAt &&
        a.projectedItem === bm.projectedItem &&
        a.message === bm.message &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming
      );
    }

    case "turn-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "attempt-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "context-compaction": {
      const bc = b as typeof a;
      return a.createdAt === bc.createdAt && a.label === bc.label && a.active === bc.active;
    }

    case "restart-divider": {
      const br = b as typeof a;
      return (
        a.createdAt === br.createdAt &&
        a.restarts.length === br.restarts.length &&
        a.restarts.every(
          (restart, index) =>
            restart.at === br.restarts[index]?.at &&
            restart.summary === br.restarts[index]?.summary,
        )
      );
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "html-render": {
      // Entries rebuild on any tool update; an equal page must keep its mounted frame.
      const bh = b as typeof a;
      return a.createdAt === bh.createdAt && htmlRenderReferencesEqual(a.htmlRender, bh.htmlRender);
    }

    case "mcp-app": {
      // Same reason: an equal app keeps its live frame and its state.
      const bm = b as typeof a;
      return (
        a.createdAt === bm.createdAt &&
        a.revision === bm.revision &&
        mcpAppReferencesEqual(a.mcpApp, bm.mcpApp)
      );
    }

    case "event":
      return (
        a.projectedItem === (b as typeof a).projectedItem &&
        a.resourceSummary === (b as typeof a).resourceSummary &&
        Equal.equals(a.subagents, (b as typeof a).subagents)
      );

    case "work": {
      const bw = b as typeof a;
      return (
        a.isExpandedToolGroup === bw.isExpandedToolGroup &&
        a.displayLabel === bw.displayLabel &&
        a.groupId === bw.groupId &&
        a.closing === bw.closing &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      );
    }

    case "work-live": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.expanded === bw.expanded &&
        a.closing === bw.closing &&
        a.active === bw.active &&
        Equal.equals(a.entry, bw.entry) &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      );
    }

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.runId === bw.runId &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.closing === bw.closing &&
        a.summary === bw.summary &&
        a.summaryIcon === bw.summaryIcon &&
        Equal.equals(a.toolIcon, bw.toolIcon) &&
        a.hasFailure === bw.hasFailure
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.projectedItem === bm.projectedItem &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.showLiveActivity === bm.showLiveActivity &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\((?:<[^>\n]*>|[^\s)]*)\)/g;

function visibleUserMessageText(text: string): string {
  const linkLabels = (segment: string) => segment.replace(MARKDOWN_LINK, "$1");
  let visible = "";
  let cursor = 0;
  for (const match of collectAssistantCitations(text)) {
    visible += linkLabels(text.slice(cursor, match.start)) + assistantCitationLabel(match.citation);
    cursor = match.end;
  }
  return visible + linkLabels(text.slice(cursor));
}

export function shouldCollapseUserMessage(text: string): boolean {
  const visible = visibleUserMessageText(text);
  if (visible.trim().length === 0) {
    return false;
  }

  return (
    visible.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    visible.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

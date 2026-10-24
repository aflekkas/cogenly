import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import type {
  ChatAttachment as ContractChatAttachment,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  ArrowUpIcon,
  Clock3Icon,
  CornerUpRightIcon,
  GripVerticalIcon,
  ListOrderedIcon,
  PencilIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type Ref,
} from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { threadEnvironment } from "../../state/threads";
import { useThreadProjection } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { isImageAttachment, type ChatMessage } from "../../types";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";
import { NoticePresenceFrame } from "./ComposerBannerStack";
import { composerStackBodyProps, useComposerStackFold } from "./ComposerStackColumn";
import { mergeQueuedRowSlots, type QueuedRowSlot } from "./queuedRowPresence";
import { PANEL_MOTION_EASING } from "~/lib/panelFlip";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface EditQueuedRunRequest {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ContractChatAttachment>;
}

interface QueuedRowThumbnail {
  readonly key: string;
  readonly name: string;
  readonly url: string | null;
}

const QUEUED_RUN_DRAG_TYPE = "application/x-cogenly-queued-run";
// Rows that change places glide to their new slot on the composer's timing.
const QUEUED_ROW_REORDER_MS = 200;
const ANIMATE_ROW_MOUNT = { current: true } as const;
const SKIP_ROW_MOUNT = { current: false } as const;
const QUEUED_ROW_REORDER_ANIMATION_ID = "queued-row-reorder";
const NO_QUEUED_RUNS: ReadonlyArray<never> = [];
// The user's own pending messages fold last when the composer stack runs out of room.
const QUEUE_STACK_ID = "queue";
const QUEUE_STACK_RANK = 3;

/** Each row's top, relative to the list, so scrolling the list does not count as moving. */
function measureQueuedRowTops(list: HTMLElement) {
  const listTop = list.getBoundingClientRect().top;
  const tops = new Map<string, number>();
  for (const row of list.querySelectorAll<HTMLElement>("[data-queued-row-key]")) {
    const key = row.dataset.queuedRowKey;
    if (key !== undefined) tops.set(key, row.getBoundingClientRect().top - listTop);
  }
  return tops;
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface QueuedRunsControlHandle {
  steerNext: (repeat: boolean) => boolean;
  sendAll: (repeat: boolean) => boolean;
  editLatest: (repeat: boolean) => boolean;
}

export function QueuedRunsControl({
  ref,
  ...props
}: {
  readonly ref?: Ref<QueuedRunsControlHandle>;
  readonly steerShortcutLabel?: string | null;
  readonly editShortcutLabel?: string | null;
  readonly sendAllShortcutLabel?: string | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly optimisticMessages: ReadonlyArray<
    Pick<ChatMessage, "id" | "inputIntent" | "text" | "attachments">
  >;
  /** The saved queue entry stays visible while its draft is edited in the composer. */
  readonly editingRunId: RunId | null;
  readonly onEditQueuedRun: (request: EditQueuedRunRequest) => void;
  readonly onCancelEdit: () => void;
}) {
  const projection = useThreadProjection(
    scopeThreadRef(props.environmentId, props.threadId),
  )?.projection;
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun);
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun);
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const [expanded, setExpanded] = useState(true);
  // The stack may fold the list to its header when it runs out of room.
  const stackFold = useComposerStackFold(QUEUE_STACK_ID);
  const listShown = expanded && !stackFold.folded;
  const queueListId = useId();
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const clearQueue = useAtomCommand(threadEnvironment.clearThreadQueue);
  const sendAllQueued = useAtomCommand(threadEnvironment.sendAllQueuedMessages);
  const [bulkAction, setBulkAction] = useState<"clear" | "send-all" | null>(null);
  // Clear all removes the whole queue, so its first press only arms it.
  const [confirmingClear, setConfirmingClear] = useState(false);
  const anyBusy = busyRunId !== null || bulkAction !== null;
  // Live drag-reorder state: the dragged run and the queue index the row
  // would be inserted at (0..queued.length) as of the latest dragover.
  const [dragState, setDragState] = useState<{
    readonly runId: RunId;
    readonly insertIndex: number | null;
  } | null>(null);
  // Drags must start from the grip, not from an accidental text-drag on the
  // row. The grip arms its run id on pointerdown; dragstart verifies it.
  const dragArmedRunIdRef = useRef<RunId | null>(null);
  const workflow = useMemo(
    () => (projection ? deriveThreadQueueWorkflowState(projection) : null),
    [projection],
  );
  const queued = workflow?.queuedRuns ?? NO_QUEUED_RUNS;
  const activeRun = workflow?.activeRun ?? null;
  const canReorder = workflow?.canReorder === true;
  const queuedImageAttachmentIds = useMemo(() => {
    const ids: string[] = [];
    for (const { attachments } of workflow?.queuedRuns ?? []) {
      for (const attachment of attachments) {
        if (attachment.type === "image") ids.push(attachment.id);
      }
    }
    return ids;
  }, [workflow]);
  const queuedImageAttachmentResources = useMemo(
    () =>
      queuedImageAttachmentIds.map((attachmentId) => ({
        _tag: "attachment" as const,
        attachmentId,
      })),
    [queuedImageAttachmentIds],
  );
  const queuedImageAttachmentUrls = useAssetUrls(
    props.environmentId,
    queuedImageAttachmentResources,
  );
  const queuedImageUrlById = useMemo(
    () =>
      new Map(
        queuedImageAttachmentIds.flatMap((attachmentId, index) => {
          const url = queuedImageAttachmentUrls[index];
          return url ? [[attachmentId, url] as const] : [];
        }),
      ),
    [queuedImageAttachmentIds, queuedImageAttachmentUrls],
  );
  // Once the projection holds the message the optimistic copy is stale no
  // matter what happened to its run — keying on still-queued runs alone would
  // resurrect a phantom "pending" row after the run is cancelled or started.
  const acknowledgedMessageIds = useMemo(
    () => new Set((projection?.messages ?? []).map((message) => message.id)),
    [projection],
  );
  const optimisticQueued = props.optimisticMessages.filter(
    (message) => message.inputIntent === "queued_turn" && !acknowledgedMessageIds.has(message.id),
  );
  const items = [
    // Keyed by message: the optimistic row and the saved entry it becomes are one row.
    ...queued.map(({ run, text, attachments }, serverIndex) => ({
      key: run.userMessageId as string,
      runId: run.id,
      messageId: run.userMessageId,
      serverIndex,
      text,
      attachments,
      thumbnails: attachments
        .filter((attachment) => attachment.type === "image")
        .map<QueuedRowThumbnail>((attachment) => ({
          key: attachment.id,
          name: attachment.name,
          url: queuedImageUrlById.get(attachment.id) ?? null,
        })),
      pending: false,
    })),
    ...optimisticQueued.map((message) => ({
      key: message.id as string,
      runId: null,
      messageId: null,
      serverIndex: null,
      text: message.text,
      attachments: [] as ReadonlyArray<ContractChatAttachment>,
      thumbnails: (message.attachments ?? [])
        .filter(isImageAttachment)
        .map<QueuedRowThumbnail>((attachment) => ({
          key: attachment.id,
          name: attachment.name,
          url: attachment.previewUrl ?? null,
        })),
      pending: true,
    })),
  ];

  type QueueItem = (typeof items)[number];
  // Rows enter, leave and reorder in motion, so what is drawn trails the queue:
  // a row that left stays until its collapse ends, and an emptied queue keeps
  // its last rows while the tray closes around them.
  const rowSignature = items
    .map((item) => `${item.key}\u0000${item.pending}\u0000${item.text}`)
    .join("\u0001");
  const [presence, setPresence] = useState<{
    readonly signature: string;
    readonly rows: ReadonlyArray<QueuedRowSlot<QueueItem>>;
  }>(() => ({
    signature: rowSignature,
    rows: items.map((item) => ({ key: item.key, item, leaving: false, animateEnter: false })),
  }));
  if (presence.signature !== rowSignature) {
    setPresence({
      signature: rowSignature,
      rows:
        items.length === 0
          ? presence.rows
          : mergeQueuedRowSlots(
              presence.rows,
              items.map((item) => ({ key: item.key, item })),
            ),
    });
  }
  const itemsByKey = new Map(items.map((item) => [item.key, item]));
  const trayOpen = items.length > 0;
  const shownCount =
    items.length > 0 ? items.length : presence.rows.filter((row) => !row.leaving).length;
  const removeLeftRow = useCallback((key: string) => {
    setPresence((current) => ({
      ...current,
      rows: current.rows.filter((row) => !(row.leaving && row.key === key)),
    }));
  }, []);
  const clearClosedTray = useCallback(() => {
    setPresence((current) => ({ ...current, rows: [] }));
  }, []);
  // A queue already up when the composer mounts (a thread switch) is just there.
  const trayMountedRef = useRef(false);
  useEffect(() => {
    trayMountedRef.current = true;
  }, []);

  // Reorder FLIP: where each row was drawn when the user moved one, played
  // once the server order lands.
  const listRef = useRef<HTMLOListElement>(null);
  const reorderSnapshotRef = useRef<{
    readonly tops: Map<string, number>;
    readonly order: string;
  } | null>(null);
  const shownOrder = presence.rows
    .filter((row) => !row.leaving)
    .map((row) => row.key)
    .join("\u0001");
  useLayoutEffect(() => {
    const snapshot = reorderSnapshotRef.current;
    const list = listRef.current;
    if (!snapshot || !list || snapshot.order === shownOrder) return;
    reorderSnapshotRef.current = null;
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-queued-row-key]"));
    for (const row of rows) {
      for (const animation of row.getAnimations()) {
        if (animation.id === QUEUED_ROW_REORDER_ANIMATION_ID) animation.cancel();
      }
    }
    const tops = measureQueuedRowTops(list);
    const reducedMotion = prefersReducedMotion();
    for (const row of rows) {
      const key = row.dataset.queuedRowKey;
      const before = key === undefined ? undefined : snapshot.tops.get(key);
      const after = key === undefined ? undefined : tops.get(key);
      if (before === undefined || after === undefined) continue;
      const offset = before - after;
      if (Math.abs(offset) < 0.5) continue;
      const animation = row.animate(
        reducedMotion
          ? [{ opacity: 0.4 }, { opacity: 1 }]
          : [{ translate: `0 ${offset}px` }, { translate: "0 0" }],
        { duration: QUEUED_ROW_REORDER_MS, easing: PANEL_MOTION_EASING },
      );
      animation.id = QUEUED_ROW_REORDER_ANIMATION_ID;
    }
  });

  const move = async (runId: RunId, beforeRunId: RunId | null) => {
    if (listRef.current) {
      reorderSnapshotRef.current = {
        tops: measureQueuedRowTops(listRef.current),
        order: shownOrder,
      };
    }
    setBusyRunId(runId);
    try {
      const result = await reorder({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId, beforeRunId },
      });
      // A reorder the server refused must not animate a later, unrelated change.
      if (result._tag === "Failure") reorderSnapshotRef.current = null;
    } finally {
      setBusyRunId(null);
    }
  };

  const completeDrag = (runId: RunId, insertIndex: number | null) => {
    setDragState(null);
    dragArmedRunIdRef.current = null;
    if (insertIndex === null || anyBusy) return;
    const draggedIndex = queued.findIndex(({ run }) => run.id === runId);
    if (draggedIndex === -1) return;
    // Inserting immediately before or after itself is a no-op.
    if (insertIndex === draggedIndex || insertIndex === draggedIndex + 1) return;
    void move(runId, queued[insertIndex]?.run.id ?? null);
  };

  const steerInFlightRef = useRef(false);
  const steer = async (queuedRunId: RunId) => {
    if (activeRun === null || !workflow?.canPromoteToSteer || steerInFlightRef.current) return;
    steerInFlightRef.current = true;
    setBusyRunId(queuedRunId);
    try {
      await promote({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, queuedRunId, targetRunId: activeRun.id },
      });
    } finally {
      steerInFlightRef.current = false;
      setBusyRunId(null);
    }
  };

  // Bulk actions wait while a queued message is open in the composer, so the
  // draft being edited never loses its queue entry underneath it.
  const canBulkAct = queued.length > 0 && props.editingRunId === null;
  const bulkInFlightRef = useRef(false);
  const runBulkAction = async (action: "clear" | "send-all") => {
    setConfirmingClear(false);
    if (!canBulkAct || bulkInFlightRef.current) return;
    bulkInFlightRef.current = true;
    setBulkAction(action);
    try {
      const target = { environmentId: props.environmentId, input: { threadId: props.threadId } };
      await (action === "clear" ? clearQueue(target) : sendAllQueued(target));
    } finally {
      bulkInFlightRef.current = false;
      setBulkAction(null);
    }
  };

  useImperativeHandle(ref, () => ({
    steerNext(repeat) {
      const next = queued[0];
      if (!next || !workflow?.canPromoteToSteer) return false;
      if (!repeat && !anyBusy) void steer(next.run.id);
      return true;
    },
    sendAll(repeat) {
      if (!canBulkAct) return false;
      if (!repeat && !anyBusy) void runBulkAction("send-all");
      return true;
    },
    // Declines while a queued message is already being edited so the key keeps
    // moving the caret inside that draft.
    editLatest(repeat) {
      const latest = queued.at(-1);
      if (!latest || props.editingRunId !== null || anyBusy) return false;
      if (!repeat) {
        setExpanded(true);
        if (stackFold.folded) stackFold.reveal();
        props.onEditQueuedRun({
          runId: latest.run.id,
          messageId: latest.run.userMessageId,
          text: latest.text,
          attachments: latest.attachments,
        });
      }
      return true;
    },
  }));

  if (presence.rows.length === 0) return null;

  const remove = async (runId: RunId) => {
    setBusyRunId(runId);
    try {
      await cancel({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId },
      });
    } finally {
      setBusyRunId(null);
    }
  };

  return (
    <ComposerBanner.Attachment>
      <NoticePresenceFrame
        open={trayOpen}
        swapKey={null}
        animateMountRef={trayMountedRef}
        onClosed={clearClosedTray}
      >
        <ComposerBanner.Root
          role="region"
          aria-label={`${shownCount} queued message${shownCount === 1 ? "" : "s"}`}
          aria-live="polite"
          inert={!trayOpen}
          data-chat-composer-collapsed-controls="true"
          className="relative z-0"
        >
          {/* The whole header toggles the list; the bulk actions sit above that toggle. */}
          <ComposerBanner.Row className="relative" onPointerLeave={() => setConfirmingClear(false)}>
            <button
              type="button"
              aria-label={listShown ? "Collapse queued messages" : "Expand queued messages"}
              aria-expanded={listShown}
              aria-controls={queueListId}
              className="absolute inset-0 cursor-pointer rounded-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() =>
                expanded && stackFold.folded ? stackFold.reveal() : setExpanded((value) => !value)
              }
            />
            <ComposerBanner.Icon>
              <ListOrderedIcon />
            </ComposerBanner.Icon>
            <ComposerBanner.Content className="text-muted-foreground">
              Queued
            </ComposerBanner.Content>
            <ComposerBanner.Actions>
              {queued.length > 0 ? (
                <span
                  data-active={confirmingClear || bulkAction !== null || undefined}
                  className={cn(
                    "relative flex items-center gap-1 opacity-0 transition-opacity duration-150 ease-out",
                    "group-hover/banner-row:opacity-100 group-focus-within/banner-row:opacity-100 data-active:opacity-100 pointer-coarse:opacity-100",
                  )}
                >
                  <Tooltip>
                    <TooltipTrigger render={<span className="flex shrink-0" />}>
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        disabled={!canBulkAct || anyBusy}
                        onClick={() => void runBulkAction("send-all")}
                      >
                        <ArrowUpIcon className="size-3.5" />
                        Send all
                      </Button>
                    </TooltipTrigger>
                    <TooltipPopup>
                      {props.editingRunId !== null
                        ? "Finish editing the queued message first"
                        : `${
                            workflow?.canPromoteToSteer
                              ? "Steer every queued message into the running turn as one message"
                              : "Send every queued message now as one message"
                          }${props.sendAllShortcutLabel ? ` (${props.sendAllShortcutLabel})` : ""}`}
                    </TooltipPopup>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger render={<span className="flex shrink-0" />}>
                      <Button
                        size="xs"
                        variant={confirmingClear ? "ghost-destructive" : "ghost-muted"}
                        aria-label={
                          confirmingClear
                            ? `Confirm removing all ${queued.length} queued messages`
                            : "Remove all queued messages"
                        }
                        disabled={!canBulkAct || anyBusy}
                        onClick={() =>
                          confirmingClear ? void runBulkAction("clear") : setConfirmingClear(true)
                        }
                        onBlur={() => setConfirmingClear(false)}
                        onKeyDown={(event) => {
                          if (event.key !== "Escape" || !confirmingClear) return;
                          event.preventDefault();
                          event.stopPropagation();
                          setConfirmingClear(false);
                        }}
                      >
                        {confirmingClear ? `Clear ${queued.length}?` : "Clear all"}
                      </Button>
                    </TooltipTrigger>
                    <TooltipPopup>
                      {props.editingRunId !== null
                        ? "Finish editing the queued message first"
                        : confirmingClear
                          ? "Press again to remove every queued message"
                          : "Remove every queued message"}
                    </TooltipPopup>
                  </Tooltip>
                </span>
              ) : null}
              <ComposerBanner.Count>{shownCount}</ComposerBanner.Count>
              <ComposerBanner.ToggleIcon expanded={listShown} />
            </ComposerBanner.Actions>
          </ComposerBanner.Row>
          {/* Opens and closes on height plus fade; the tray grows upward from the composer. */}
          <div
            {...composerStackBodyProps(QUEUE_STACK_ID, QUEUE_STACK_RANK, expanded)}
            inert={!listShown}
            className={cn(
              "grid transition-[grid-template-rows,opacity] duration-200 ease-standard motion-reduce:transition-opacity",
              listShown ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <ComposerBanner.Scroll className="[--composer-banner-scroll-max:--spacing(32)]">
                <ComposerBanner.Children render={<ol ref={listRef} />} id={queueListId}>
                  {presence.rows.map((slot) => {
                    const item = (slot.leaving ? undefined : itemsByKey.get(slot.key)) ?? slot.item;
                    const previewText = replaceComposerContextReferences(item.text, (reference) =>
                      reference.kind === "image" && item.thumbnails.length > 0
                        ? ""
                        : reference.label,
                    ).trim();
                    const rowRunId = item.runId;
                    const rowServerIndex = item.serverIndex;
                    const isEditing = rowRunId !== null && rowRunId === props.editingRunId;
                    const rowDraggable =
                      rowRunId !== null && rowServerIndex !== null && canReorder && !anyBusy;
                    return (
                      <QueuedRowPresence
                        key={slot.key}
                        rowKey={slot.key}
                        leaving={slot.leaving}
                        animateEnter={slot.animateEnter}
                        onLeft={removeLeftRow}
                        aria-current={isEditing ? "true" : undefined}
                      >
                        <ComposerBanner.Row
                          className={cn(
                            "relative rounded-sm",
                            isEditing && "state-selected",
                            dragState !== null && dragState.runId === item.runId && "opacity-50",
                          )}
                          draggable={rowDraggable}
                          onDragStart={(event) => {
                            if (item.runId === null || dragArmedRunIdRef.current !== item.runId) {
                              event.preventDefault();
                              return;
                            }
                            event.dataTransfer.setData(QUEUED_RUN_DRAG_TYPE, item.runId);
                            event.dataTransfer.effectAllowed = "move";
                            setDragState({ runId: item.runId, insertIndex: null });
                          }}
                          onDragEnd={() => {
                            dragArmedRunIdRef.current = null;
                            setDragState(null);
                          }}
                          onDragOver={(event) => {
                            if (dragState === null || item.serverIndex === null) return;
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            const rect = event.currentTarget.getBoundingClientRect();
                            const insertIndex =
                              event.clientY < rect.top + rect.height / 2
                                ? item.serverIndex
                                : item.serverIndex + 1;
                            if (dragState.insertIndex !== insertIndex) {
                              setDragState({ runId: dragState.runId, insertIndex });
                            }
                          }}
                          onDrop={(event) => {
                            if (dragState === null) return;
                            event.preventDefault();
                            completeDrag(dragState.runId, dragState.insertIndex);
                          }}
                        >
                          {item.serverIndex !== null &&
                          dragState?.insertIndex === item.serverIndex ? (
                            <span
                              aria-hidden
                              className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded bg-primary/70"
                            />
                          ) : null}
                          {item.serverIndex === queued.length - 1 &&
                          dragState?.insertIndex === queued.length ? (
                            <span
                              aria-hidden
                              className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 rounded bg-primary/70"
                            />
                          ) : null}
                          <ComposerBanner.Icon aria-hidden={false}>
                            {canReorder && rowRunId !== null && rowServerIndex !== null ? (
                              <Button
                                size="icon-xs"
                                variant="ghost-muted"
                                aria-label="Reorder queued message (drag, or press the arrow keys)"
                                className="cursor-grab active:cursor-grabbing disabled:cursor-default"
                                disabled={anyBusy}
                                onPointerDown={() => {
                                  dragArmedRunIdRef.current = rowRunId;
                                }}
                                onKeyDown={(event) => {
                                  if (anyBusy) return;
                                  if (event.key === "ArrowUp" && rowServerIndex > 0) {
                                    event.preventDefault();
                                    void move(rowRunId, queued[rowServerIndex - 1]?.run.id ?? null);
                                  }
                                  if (
                                    event.key === "ArrowDown" &&
                                    rowServerIndex < queued.length - 1
                                  ) {
                                    event.preventDefault();
                                    void move(rowRunId, queued[rowServerIndex + 2]?.run.id ?? null);
                                  }
                                }}
                              >
                                <GripVerticalIcon />
                              </Button>
                            ) : null}
                          </ComposerBanner.Icon>
                          <ComposerBanner.Content className="text-foreground/80">
                            {isEditing ? (
                              <span className="sr-only">Editing queued message: </span>
                            ) : null}
                            {item.pending ? (
                              <Clock3Icon
                                aria-label="Saving queued message"
                                className="size-3 shrink-0 text-muted-foreground/60"
                              />
                            ) : null}
                            {item.thumbnails.length > 0 ? (
                              <span className="flex shrink-0 items-center gap-0.5">
                                {item.thumbnails.map((thumbnail) => (
                                  <span
                                    key={thumbnail.key}
                                    className="size-4 overflow-hidden rounded border border-border/70 bg-background"
                                  >
                                    {thumbnail.url ? (
                                      <img
                                        src={thumbnail.url}
                                        alt={thumbnail.name}
                                        className="size-full object-cover"
                                      />
                                    ) : (
                                      <span
                                        aria-label={thumbnail.name}
                                        className="block size-full bg-muted/60"
                                      />
                                    )}
                                  </span>
                                ))}
                              </span>
                            ) : null}
                            <QueuedRowPreview text={previewText} />
                          </ComposerBanner.Content>
                          <ComposerBanner.Actions>
                            {isEditing ? (
                              <Button
                                size="xs"
                                variant="ghost-muted"
                                aria-label="Cancel editing queued message"
                                onClick={props.onCancelEdit}
                              >
                                Cancel
                              </Button>
                            ) : (
                              <>
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <Button
                                        size="icon-xs"
                                        variant="ghost-muted"
                                        aria-label="Edit queued message"
                                        disabled={item.runId === null || anyBusy}
                                        onClick={() => {
                                          if (item.runId !== null && item.messageId !== null) {
                                            props.onEditQueuedRun({
                                              runId: item.runId,
                                              messageId: item.messageId,
                                              text: item.text,
                                              attachments: item.attachments,
                                            });
                                          }
                                        }}
                                      />
                                    }
                                  >
                                    <PencilIcon className="size-3.5" />
                                  </TooltipTrigger>
                                  <TooltipPopup>
                                    {`Edit in the composer${item.serverIndex === queued.length - 1 && props.editShortcutLabel ? ` (${props.editShortcutLabel})` : ""}`}
                                  </TooltipPopup>
                                </Tooltip>
                                <Tooltip>
                                  <TooltipTrigger render={<span className="flex shrink-0" />}>
                                    <Button
                                      size="xs"
                                      variant="ghost-muted"
                                      disabled={
                                        item.runId === null ||
                                        anyBusy ||
                                        !workflow?.canPromoteToSteer
                                      }
                                      onClick={() => {
                                        if (item.runId !== null) {
                                          void steer(item.runId);
                                        }
                                      }}
                                    >
                                      <CornerUpRightIcon className="size-3.5" />
                                      Steer
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipPopup>
                                    {activeRun === null
                                      ? "There is no active run to steer"
                                      : !workflow?.canPromoteToSteer
                                        ? "Starts when the active turn finishes"
                                        : `Send as a steer instead${item.serverIndex === 0 && props.steerShortcutLabel ? ` (${props.steerShortcutLabel})` : ""}`}
                                  </TooltipPopup>
                                </Tooltip>
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <ComposerBanner.Dismiss
                                        variant="ghost-muted"
                                        aria-label="Remove queued message"
                                        disabled={item.runId === null || anyBusy}
                                        onClick={() => {
                                          if (item.runId !== null) void remove(item.runId);
                                        }}
                                      />
                                    }
                                  />
                                  <TooltipPopup>Remove from queue</TooltipPopup>
                                </Tooltip>
                              </>
                            )}
                          </ComposerBanner.Actions>
                        </ComposerBanner.Row>
                      </QueuedRowPresence>
                    );
                  })}
                </ComposerBanner.Children>
              </ComposerBanner.Scroll>
            </div>
          </div>
        </ComposerBanner.Root>
      </NoticePresenceFrame>
    </ComposerBanner.Attachment>
  );
}

/** One queue row: grows in when it arrives after the tray, collapses and fades when it leaves. */
function QueuedRowPresence({
  rowKey,
  leaving,
  animateEnter,
  onLeft,
  children,
  ...props
}: Omit<ComponentProps<"li">, "inert"> & {
  readonly rowKey: string;
  readonly leaving: boolean;
  readonly animateEnter: boolean;
  readonly onLeft: (key: string) => void;
}) {
  const handleClosed = useCallback(() => onLeft(rowKey), [onLeft, rowKey]);
  return (
    <li
      {...props}
      data-queued-row-key={rowKey}
      aria-hidden={leaving || undefined}
      inert={leaving}
      className="min-w-0"
    >
      <NoticePresenceFrame
        open={!leaving}
        swapKey={null}
        animateMountRef={animateEnter ? ANIMATE_ROW_MOUNT : SKIP_ROW_MOUNT}
        onClosed={handleClosed}
      >
        {children}
      </NoticePresenceFrame>
    </li>
  );
}

/** The row's text; the full text shows on hover only when the row cuts it off. */
function QueuedRowPreview({ text }: { readonly text: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        const element = textRef.current;
        setOpen(next && element !== null && element.scrollWidth > element.clientWidth);
      }}
    >
      <TooltipTrigger render={<span ref={textRef} className="min-w-0 flex-1 truncate" />}>
        {text}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-96 break-words">
        {text}
      </TooltipPopup>
    </Tooltip>
  );
}

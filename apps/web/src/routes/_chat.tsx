import { AuthPreviewOperateScope } from "@t3tools/contracts";
import { Outlet, createFileRoute, redirect, useParams } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { Activity, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { ThreadRouteView } from "../components/ThreadRouteView";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { resolveThreadRouteTarget, type ThreadRouteTarget } from "../threadRoutes";
import {
  EMPTY_THREAD_VIEW_SLOTS,
  placeThreadRouteTarget,
  slotHolding,
  THREAD_VIEW_SLOTS,
  threadRouteTargetKey,
  threadViewSlotFor,
  type ThreadViewSlot,
  type ThreadViewSlots,
} from "../threadRouteSlots";
import { settleModeSwitchMainPane } from "../components/sidebar/modes/modeSwitchMotion";
import { useClientSettings, useLegacySidebarEnabled } from "../hooks/useSettings";
import { openCommandPalette } from "../commandPaletteBus";
import { readThreadShell, useProjects } from "../state/entities";
import { isPreviewAvailableFor } from "../browser/previewRuntime";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentScope } from "../state/session";
import { selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { dispatchPreviewAction } from "../components/preview/previewActionBus";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useReadRouteThreadKind, useThreadKindResolver } from "../hooks/useThreadKind";
import { sidebarModeForThreadKind, threadCapabilities } from "../threadCapabilities";
import { useScratchProject } from "../hooks/useScratchProject";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isEditableFocused } from "../lib/editableFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { undoLatestThreadAction } from "../hooks/showThreadUndoNotice";
import { resolveShortcutCommand } from "../keybindings";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useUiStateStore } from "../uiStateStore";
import { newThreadShortcutTarget } from "../components/sidebar/modes/sidebarModes.logic";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { primaryServerKeybindingsAtom } from "~/state/server";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const canOperatePreview = useEnvironmentScope(
    routeThreadRef?.environmentId ?? null,
    AuthPreviewOperateScope,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const readRouteThreadKind = useReadRouteThreadKind();
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread, startNewChat } = useScratchProject();
  const sidebarMode = useUiStateStore((store) => store.sidebarMode);
  const projectGroupCount = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }).length,
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );
  // The `previewOpen` shortcut-context flag here uses the store-only value;
  // the URL-aware arbitration lives inside ChatView's `onTogglePreview`,
  // which we invoke via the action bus to avoid duplicating the rule.
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          previewFocus: isPreviewFocused(),
          previewOpen,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });

      if (isCommandPaletteOpen()) {
        return;
      }

      if (command === "thread.undo") {
        if (event.repeat || isModelPickerOpen()) return;
        if (undoLatestThreadAction()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      if (event.key === "Escape" && selectedThreadKeysSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      if (command === "chat.newWithoutProject") {
        const environmentId = scratchEnvironmentId(
          activeThread?.environmentId ?? activeDraftThread?.environmentId ?? primaryEnvironmentId,
        );
        if (environmentId === null) return;
        event.preventDefault();
        event.stopPropagation();
        void startScratchThread(environmentId);
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        // Chats makes a plain chat. Otherwise the default sidebar routes
        // creation through the command palette whenever there is a real
        // choice to make; the legacy sidebar (and single-project setups) keep
        // the immediate contextual create.
        const target = newThreadShortcutTarget({
          mode: sidebarMode,
          legacySidebar: legacySidebarEnabled,
          repositoryCount: projectGroupCount,
        });
        if (target === "chat") {
          startNewChat(
            activeThread?.environmentId ?? activeDraftThread?.environmentId ?? primaryEnvironmentId,
          );
          return;
        }
        if (target === "repository-picker") {
          openCommandPalette({ open: "new-thread-in" });
          return;
        }
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      if (command === "preview.toggle") {
        // A thread without a browser keeps whatever else the chord means there.
        const kind = readRouteThreadKind();
        if (kind !== null && !threadCapabilities(kind).browser) return;
        event.preventDefault();
        event.stopPropagation();
        if (!routeThreadRef || (!canOperatePreview && !previewOpen)) return;
        if (!isPreviewAvailableFor(routeThreadRef.environmentId)) {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "Preview is desktop-only",
              description: "Open Cogenly in the desktop app to use the in-app preview.",
            }),
          );
          return;
        }
        dispatchPreviewAction("toggle-panel");
        return;
      }

      // The remaining preview commands only fire when the panel is the
      // currently-focused tenant. The `when: previewFocus` rule already
      // gates this, but defend against the keybinding being misconfigured.
      if (
        command === "preview.refresh" ||
        command === "preview.focusUrl" ||
        command === "preview.zoomIn" ||
        command === "preview.zoomOut" ||
        command === "preview.resetZoom"
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (!canOperatePreview) return;
        const action =
          command === "preview.refresh"
            ? "refresh"
            : command === "preview.focusUrl"
              ? "focus-url"
              : command === "preview.zoomIn"
                ? "zoom-in"
                : command === "preview.zoomOut"
                  ? "zoom-out"
                  : "reset-zoom";
        dispatchPreviewAction(action);
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    canOperatePreview,
    handleNewThread,
    keybindings,
    defaultProjectRef,
    previewOpen,
    primaryEnvironmentId,
    readRouteThreadKind,
    projectGroupCount,
    routeThreadRef,
    scratchEnvironmentId,
    selectedThreadKeysSize,
    sidebarMode,
    startNewChat,
    startScratchThread,
    legacySidebarEnabled,
  ]);

  return null;
}

/** The longest the previous thread stands in for a route with nothing to show yet. */
const RETAINED_THREAD_VIEW_MAX_MS = 1000;

function ChatRouteLayout() {
  // Both thread routes render here, not in their own leaf components, so the
  // draft-to-thread promotion keeps one ChatView mounted across the swap.
  const threadTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const threadTargetKey = threadTarget ? threadRouteTargetKey(threadTarget) : null;
  // Chats, Work and Agents each keep their last thread and draft views mounted, hidden
  // with its effects (listeners, subscriptions) torn down, so a mode switch
  // reveals it instead of mounting a new ChatView. See threadRouteSlots.ts.
  const resolveThreadKind = useThreadKindResolver();
  const [slots, setSlots] = useState<ThreadViewSlots>(EMPTY_THREAD_VIEW_SLOTS);
  if (threadTarget && threadTargetKey !== null) {
    const placed = placeThreadRouteTarget(
      slots,
      { key: threadTargetKey, target: threadTarget },
      () => slotForThreadRouteTarget(threadTarget, slots, resolveThreadKind),
    );
    if (placed !== slots) setSlots(placed);
  }
  // Leaving a thread for a route that shows nothing yet (the index while it
  // lands on the picked mode's thread, a route chunk still loading) keeps the
  // thread on screen, inert, instead of a blank frame. The next thread of the
  // same mode reuses that view, and index.css hides it as soon as the outlet
  // has content.
  const [retainedHidden, setRetainedHidden] = useState(false);
  if (threadTarget && retainedHidden) setRetainedHidden(false);
  const outletRef = useRef<HTMLDivElement | null>(null);
  const outletRendered = threadTarget === null;
  useLayoutEffect(() => {
    const outlet = outletRef.current;
    if (!outletRendered || !outlet) return;
    const settle = () => {
      if (outlet.firstElementChild === null) return false;
      settleModeSwitchMainPane();
      setRetainedHidden(true);
      return true;
    };
    if (settle()) return;
    // Runs before the frame that paints the new content.
    const observer = new MutationObserver(() => {
      if (settle()) observer.disconnect();
    });
    observer.observe(outlet, { childList: true });
    const timeout = window.setTimeout(() => setRetainedHidden(true), RETAINED_THREAD_VIEW_MAX_MS);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
    };
  }, [outletRendered]);
  return (
    <>
      <ChatRouteGlobalShortcuts />
      {threadTarget?.kind === "server" ? (
        <ThreadLinkPrompt threadRef={threadTarget.threadRef} />
      ) : null}
      {THREAD_VIEW_SLOTS.map((slot) => {
        const entry = slots.entries[slot];
        if (!entry) return null;
        const shown = slot === slots.active;
        return (
          <Activity
            key={slot}
            mode={shown && (threadTarget !== null || !retainedHidden) ? "visible" : "hidden"}
          >
            <ThreadRouteView target={entry.target} retained={!shown || threadTarget === null} />
          </Activity>
        );
      })}
      {outletRendered ? (
        <div ref={outletRef} className="contents" data-chat-outlet="">
          <Outlet />
        </div>
      ) : null}
    </>
  );
}

/**
 * The slot a newly opened thread goes to: the one holding the draft it was
 * promoted from, else its mode's; null while its mode is unknown.
 */
function slotForThreadRouteTarget(
  target: ThreadRouteTarget,
  slots: ThreadViewSlots,
  resolveThreadKind: ReturnType<typeof useThreadKindResolver>,
): ThreadViewSlot | null {
  const drafts = useComposerDraftStore.getState();
  if (target.kind === "server") {
    const promotedFrom = drafts.getDraftIdByRef(target.threadRef);
    const promotedSlot = promotedFrom === null ? null : slotHolding(slots, `draft:${promotedFrom}`);
    if (promotedSlot !== null) return promotedSlot;
  }
  const thread =
    target.kind === "server"
      ? readThreadShell(target.threadRef)
      : drafts.getDraftSession(target.draftId);
  return thread
    ? threadViewSlotFor(sidebarModeForThreadKind(resolveThreadKind(thread)), target)
    : null;
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
});

import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Bot, TerminalSquare, X } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { selectThreadBottomPanelState, useBottomPanelStore } from "~/bottomPanelStore";
import { useStableCallback } from "~/hooks/useStableCallback";
import { PANEL_MOTION_EASING } from "~/lib/panelFlip";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { PANEL_ANIMATION_DURATION, readPanelAnimationsActive } from "~/panelAnimations";
import { useThreadShells } from "~/state/entities";
import {
  readEnvironmentScope,
  useEnvironmentScope,
  useEnvironmentScopeAccess,
} from "~/state/session";
import { terminalEnvironment } from "~/state/terminal";
import { useKnownTerminalSessions } from "~/state/terminalSessions";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  agentTerminalEntries,
  agentTerminalsPanelState,
  resolveSelected,
  type AgentTerminalEntry,
} from "../AgentTerminalsPanel.logic";
import { PanelTab } from "../PanelTab";
import { TabStrip } from "../TabStrip";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentRunsView } from "./AgentRunsView";
import {
  bottomPanelMaxHeight,
  bottomPanelTabs,
  bottomPanelTabStatus,
  bottomPanelToggleShowsActivity,
  clampBottomPanelHeight,
  findRunForToolCall,
  resolveActiveBottomPanelTab,
  type BottomPanelAgent,
  type BottomPanelTab,
} from "./bottomPanel.logic";

/** Something that glides with the panel's top edge, `shift` of its height (½ for centred content). */
export interface BottomPanelMotionTarget {
  readonly element: HTMLElement;
  readonly shift: number;
}

export type BottomPanelRunResolver = (
  call: Parameters<typeof findRunForToolCall>[1],
) => ReturnType<typeof findRunForToolCall>;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const EMPTY_ENTRIES: ReadonlyArray<AgentTerminalEntry> = [];

/**
 * The agent tabs for a thread: its own agent and every subagent thread under
 * it that ran a command. Subagent threads' terminals come from the
 * environment-wide list, which is only read while the thread has subagents.
 */
export function useBottomPanelTabs(threadRef: ScopedThreadRef, threadStarted: boolean) {
  const environmentId = threadRef.environmentId;
  const shells = useThreadShells();
  const subagentsKey = useMemo(() => {
    const rows: Array<[string, string]> = [];
    for (const shell of shells) {
      const { source } = shell;
      if (shell.environmentId !== environmentId || source.deletedAt !== null) continue;
      if (source.lineage.relationshipToParent !== "subagent") continue;
      if (source.lineage.parentThreadId !== threadRef.threadId) continue;
      rows.push([source.id, source.title.replace(/^Subagent:\s*/i, "").trim() || "Subagent"]);
    }
    return JSON.stringify(rows);
  }, [environmentId, shells, threadRef.threadId]);
  const subagents = useMemo<ReadonlyArray<BottomPanelAgent>>(
    () =>
      (JSON.parse(subagentsKey) as Array<[string, string]>).map(([threadId, title]) => ({
        threadId,
        title,
      })),
    [subagentsKey],
  );
  const ownSessions = useKnownTerminalSessions({
    environmentId: threadStarted ? environmentId : null,
    threadId: threadRef.threadId,
  });
  const environmentSessions = useKnownTerminalSessions({
    environmentId: threadStarted && subagents.length > 0 ? environmentId : null,
    threadId: null,
  });
  const entriesByThreadId = useMemo(() => {
    const byThread = new Map<string, ReadonlyArray<AgentTerminalEntry>>();
    byThread.set(threadRef.threadId, agentTerminalEntries(ownSessions ?? []));
    if (subagents.length > 0 && environmentSessions) {
      const wanted = new Set(subagents.map((agent) => agent.threadId));
      const grouped = new Map<string, typeof environmentSessions>();
      for (const session of environmentSessions) {
        const id = session.target.threadId;
        if (!wanted.has(id)) continue;
        grouped.set(id, [...(grouped.get(id) ?? []), session]);
      }
      for (const [id, sessions] of grouped) byThread.set(id, agentTerminalEntries(sessions));
    }
    return byThread;
  }, [environmentSessions, ownSessions, subagents, threadRef.threadId]);
  const hiddenTabs = useBottomPanelStore(
    (state) => selectThreadBottomPanelState(state.byThreadKey, threadRef).hiddenTabs,
  );
  const primary = useMemo<BottomPanelAgent>(
    () => ({ threadId: threadRef.threadId, title: "Agent" }),
    [threadRef.threadId],
  );
  const tabs = useMemo(
    () => bottomPanelTabs({ primary, subagents, entriesByThreadId, hiddenTabs }),
    [entriesByThreadId, hiddenTabs, primary, subagents],
  );
  // Hidden tabs included, so a timeline row can still find its run.
  const allTabs = useMemo(
    () => bottomPanelTabs({ primary, subagents, entriesByThreadId, hiddenTabs: undefined }),
    [entriesByThreadId, primary, subagents],
  );
  return { tabs, allTabs, sessionsLoaded: ownSessions !== null };
}

function PanelMessage({ title, detail }: { title: string; detail?: string }) {
  return (
    <Empty size="sm" className="h-full min-h-0">
      <EmptyHeader>
        <EmptyMedia>
          <TerminalSquare />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {detail ? <EmptyDescription>{detail}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  );
}

/**
 * Above the run list once more than one agent has run commands: the shared
 * TabStrip, one tab per agent, its newest run's state after the title. With
 * one agent there is nothing to switch, so no strip.
 */
const AgentSwitcher = memo(function AgentSwitcher(props: {
  tabs: ReadonlyArray<BottomPanelTab>;
  activeTabId: string | null;
  setKey: string;
  onSelect: (tabId: string) => void;
  onCloseTab: (tab: BottomPanelTab) => void;
}) {
  const { onSelect } = props;
  const activate = useCallback((tab: BottomPanelTab) => onSelect(tab.id), [onSelect]);
  return (
    // Narrow, the strip keeps clear of the panel's corner × (inset, size and gap).
    <div className="flex h-9 shrink-0 items-stretch px-1 @max-[40rem]/terminals:pe-10">
      <TabStrip
        aria-label="Agents"
        items={props.tabs}
        activeId={props.activeTabId}
        setKey={props.setKey}
        getLabel={(tab) => tab.title}
        onActivate={activate}
        onClose={props.onCloseTab}
        renderTab={(tab) => (
          <>
            <PanelTab.Icon>
              {tab.primary ? (
                <TerminalSquare aria-hidden className="size-3.5" />
              ) : (
                <Bot aria-hidden className="size-3.5" />
              )}
            </PanelTab.Icon>
            <PanelTab.Label>{tab.title}</PanelTab.Label>
            <PanelTab.Status status={bottomPanelTabStatus(tab)} />
          </>
        )}
      />
    </div>
  );
});

export interface BottomTerminalPanelProps {
  readonly threadRef: ScopedThreadRef;
  readonly threadStarted: boolean;
  /** Bumped when the user opens the panel, so keyboard focus may move into it. */
  readonly focusRequestId: number;
  readonly toggleShortcutLabel: string | null;
  readonly onAddTerminalContext: (selection: TerminalContextSelection) => void;
  /** Read when a toggle happens: the chat content that should glide with the panel's edge. */
  readonly getMotionTargets: () => ReadonlyArray<BottomPanelMotionTarget>;
  /** Filled in for the timeline, so a "Terminal run" row can open its command. */
  readonly runResolverRef: MutableRefObject<BottomPanelRunResolver | null>;
  /** Reports when the header toggle should show its dot: a command runs while the panel is closed. */
  readonly onActivityChange: (activity: boolean) => void;
}

/**
 * The resizable panel under the chat, as in T3 Code: each agent that ran
 * commands gets its command list and live output, with a switcher above the
 * list once there is more than one agent and the close × in the corner. It
 * opens only when the user asks (header toggle, shortcut, a run in the
 * timeline); an agent starting a command updates its tab in the background.
 *
 * Open and close lay the chat out once, at its final size, then glide: the
 * drawer slides solid on a translate while the content above follows its top
 * edge, so nothing resizes per frame. Reduced motion fades the panel only.
 */
export function BottomTerminalPanel(props: BottomTerminalPanelProps) {
  const { threadRef, threadStarted } = props;
  const threadKey = scopedThreadKey(threadRef);
  const panelState = useBottomPanelStore((state) =>
    selectThreadBottomPanelState(state.byThreadKey, threadRef),
  );
  const { tabs, allTabs, sessionsLoaded } = useBottomPanelTabs(threadRef, threadStarted);
  const environmentId = threadRef.environmentId;
  const readAccess = useEnvironmentScopeAccess(environmentId, AuthTerminalReadScope);
  const canOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const killTerminal = useAtomCommand(terminalEnvironment.kill, "terminal kill");

  const { runResolverRef } = props;
  useLayoutEffect(() => {
    runResolverRef.current = (call) => findRunForToolCall(allTabs, call);
  }, [allTabs, runResolverRef]);
  const open = panelState.open;
  const activity = bottomPanelToggleShowsActivity(open, tabs);
  const onActivityChange = useStableCallback(props.onActivityChange);
  useEffect(() => onActivityChange(activity), [activity, onActivityChange]);

  const [maxHeight, setMaxHeight] = useState(() =>
    bottomPanelMaxHeight({
      viewportHeight: typeof window === "undefined" ? 900 : window.innerHeight,
    }),
  );
  const height = clampBottomPanelHeight(panelState.height, maxHeight);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [resizeEpoch, setResizeEpoch] = useState(0);

  // Mounted while open, and while a close glides out.
  const [closing, setClosing] = useState(false);
  const motionRef = useRef<{
    opening: boolean;
    targets: ReadonlyArray<BottomPanelMotionTarget>;
    reduced: boolean;
  } | null>(null);
  const getMotionTargets = useStableCallback(props.getMotionTargets);

  useEffect(
    () =>
      useBottomPanelStore.subscribe((state, previous) => {
        const next = state.byThreadKey[threadKey]?.open ?? false;
        const before = previous.byThreadKey[threadKey]?.open ?? false;
        if (next === before) return;
        const reduced = window.matchMedia(REDUCED_MOTION_QUERY).matches;
        // A navigation's first frame shows restored state as it is.
        if (!reduced && !readPanelAnimationsActive()) {
          motionRef.current = null;
          setClosing(false);
          return;
        }
        motionRef.current = { opening: next, targets: reduced ? [] : getMotionTargets(), reduced };
        // A close that glides keeps the panel mounted until it has left.
        setClosing(!next);
      }),
    [getMotionTargets, threadKey],
  );

  // A thread switch shows the other thread's panel as it was left.
  const [seenThreadKey, setSeenThreadKey] = useState(threadKey);
  if (seenThreadKey !== threadKey) {
    setSeenThreadKey(threadKey);
    setClosing(false);
  }

  const playMotion = useStableCallback(() => {
    const motion = motionRef.current;
    motionRef.current = null;
    const panel = panelRef.current;
    if (!motion || !panel) return;
    const distance = height;
    const timing: KeyframeAnimationOptions = {
      duration: PANEL_ANIMATION_DURATION,
      easing: PANEL_MOTION_EASING,
      fill: "both",
    };
    // The sheet rises solid from the window's bottom edge (clipped there by the
    // workspace) and sinks back the same way; reduced motion fades it instead.
    const hidden: Keyframe = motion.reduced ? { opacity: 0 } : { translate: `0 ${distance}px` };
    const shown: Keyframe = motion.reduced ? { opacity: 1 } : { translate: "0 0" };
    const panelFrames = motion.opening ? [hidden, shown] : [shown, hidden];
    const animations = [panel.animate(panelFrames, timing)];
    for (const target of motion.targets) {
      const offset = distance * target.shift * (motion.opening ? 1 : -1);
      animations.push(
        target.element.animate([{ translate: `0 ${offset}px` }, { translate: "0 0" }], {
          ...timing,
          fill: "backwards",
        }),
      );
    }
    // Start on the frame after the commit, as panelFlip does: the commit
    // frame is the expensive one, and a motion started in it is already
    // partway along when it paints.
    for (const animation of animations) animation.pause();
    const frame = window.requestAnimationFrame(() => {
      for (const animation of animations) animation.play();
    });
    const panelAnimation = animations[0]!;
    if (!motion.opening) {
      void panelAnimation.finished.then(
        () => setClosing(false),
        () => {},
      );
    } else {
      void panelAnimation.finished.then(
        () => panelAnimation.cancel(),
        () => {},
      );
    }
    return () => {
      window.cancelAnimationFrame(frame);
      if (motion.opening) return;
      for (const animation of animations.slice(1)) animation.finish();
    };
  });
  // Plays once per toggle, after the layout at the new size commits.
  useLayoutEffect(() => playMotion(), [open, playMotion]);

  // The window and the column cap the height; measured on open and on window
  // resize only, never per frame.
  const present = open || closing;
  useLayoutEffect(() => {
    if (!present) return;
    const measure = () => {
      const column = panelRef.current?.parentElement;
      setMaxHeight(
        bottomPanelMaxHeight({
          viewportHeight: window.innerHeight,
          ...(column ? { columnHeight: column.clientHeight } : {}),
        }),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [present]);

  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    height: number;
    max: number;
  } | null>(null);
  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !panelRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const column = panelRef.current.parentElement;
    // The panel's own height counts toward what the column may give it.
    const max = bottomPanelMaxHeight({
      viewportHeight: window.innerHeight,
      ...(column ? { columnHeight: column.clientHeight } : {}),
    });
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: height,
      height,
      max,
    };
  };
  const onResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = clampBottomPanelHeight(drag.startHeight + (drag.startY - event.clientY), drag.max);
    if (next === drag.height) return;
    drag.height = next;
    // Written straight to the panel so the edge tracks the pointer without a render.
    panelRef.current?.style.setProperty("height", `${next}px`);
  };
  const onResizePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.height === drag.startHeight) return;
    useBottomPanelStore.getState().setHeight(threadRef, drag.height);
    setResizeEpoch((value) => value + 1);
  };

  const activeTab = resolveActiveBottomPanelTab(tabs, panelState.activeTabId);
  const selectTab = useStableCallback((tabId: string) =>
    useBottomPanelStore.getState().selectTab(threadRef, tabId),
  );
  const closeTab = useStableCallback((tab: BottomPanelTab) =>
    useBottomPanelStore.getState().hideTab(threadRef, tab.id, tab.latestRunKey),
  );

  if (!present) return null;

  const accessState = agentTerminalsPanelState({ threadStarted, readAccess, sessionsLoaded });
  let body;
  switch (accessState) {
    case "not-started":
      body = (
        <PanelMessage
          title="No agent runs yet"
          detail="Commands the agent runs show up here once the thread starts."
        />
      );
      break;
    case "connecting":
      body = <PanelMessage title="Connecting to terminals…" />;
      break;
    case "unreachable":
      body = (
        <PanelMessage
          title="Terminals unavailable"
          detail="Couldn’t reach this environment to check terminal access."
        />
      );
      break;
    case "denied":
      body = (
        <PanelMessage
          title="Terminals unavailable"
          detail="This connection is not allowed to view terminals in this environment."
        />
      );
      break;
    case "runs":
      body = activeTab ? (
        <AgentTabContent
          parentRef={threadRef}
          tab={activeTab}
          agentSwitcher={
            tabs.length > 1 ? (
              <AgentSwitcher
                tabs={tabs}
                activeTabId={activeTab.id}
                setKey={threadKey}
                onSelect={selectTab}
                onCloseTab={closeTab}
              />
            ) : null
          }
          selectedRunId={panelState.selectedRunByTabId?.[activeTab.id]}
          canOperate={canOperate}
          visible={open}
          focusRequestId={props.focusRequestId}
          resizeEpoch={resizeEpoch}
          onAddTerminalContext={props.onAddTerminalContext}
          onStop={(entry) => {
            if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
            void killTerminal({
              environmentId,
              input: { threadId: ThreadId.make(activeTab.threadId), terminalId: entry.terminalId },
            });
          }}
        />
      ) : (
        <PanelMessage
          title="No agent runs yet"
          detail="Each agent that runs a command gets a tab here, with its live output and how it exited."
        />
      );
      break;
  }

  return (
    <div
      ref={panelRef}
      data-bottom-panel
      data-terminal-owner="bottom-panel"
      aria-hidden={!open}
      inert={!open}
      className={cn(
        // A drawer: a raised sheet with rounded top corners, inset from the
        // sidebar and the right panel, that rests on the window's bottom edge.
        // The wrapper keeps the gap and the height; the sheet draws the surface.
        // The whole sheet is the terminal's own background, so the run list,
        // the run header and the output read as one surface split by hairlines.
        "z-40 flex min-w-0 flex-col px-2",
        open ? "relative shrink-0" : "pointer-events-none absolute inset-x-0 bottom-0",
      )}
      style={{ height }}
    >
      <div
        className={cn(
          "group/bottom-panel relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-2xl border border-b-0 bg-(--terminal-background) surface-raised",
          // The raised sheen would lift the list above the output; keep the fill flat.
          "[--surface-raised-sheen-bottom:transparent] [--surface-raised-sheen-top:transparent]",
          // Its shadow falls upward, onto the chat it rises over.
          "[--surface-raised-elevation:0_-1px_2px_rgb(0_0_0/3%),0_-10px_28px_-14px_rgb(0_0_0/14%)] dark:[--surface-raised-elevation:0_-1px_2px_rgb(0_0_0/30%),0_-12px_32px_-12px_rgb(0_0_0/70%)]",
        )}
      >
        <div
          aria-hidden
          className="group/resize absolute inset-x-0 top-0 z-20 h-2 cursor-row-resize"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerEnd}
          onPointerCancel={onResizePointerEnd}
          onLostPointerCapture={onResizePointerEnd}
        >
          {/* The grabber: faint at rest, brighter while the edge is hovered or dragged. */}
          <span className="pointer-events-none absolute top-[3px] left-1/2 h-[3px] w-8 -translate-x-1/2 rounded-full bg-foreground/10 transition-colors duration-(--motion-duration-fast) ease-out group-hover/resize:bg-foreground/25 group-active/resize:bg-foreground/35" />
        </div>
        {/* No header row: the × sits in the top-right corner, beside the run's actions.
            Its h-6 box at top-1.5 centres it on the run header's command line, and
            end-3 matches the header's left text inset. */}
        <div className="absolute end-3 top-1.5 z-30 flex h-6 items-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Close panel"
                  onClick={() => useBottomPanelStore.getState().setOpen(threadRef, false)}
                />
              }
            >
              <X />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {`Close panel${props.toggleShortcutLabel ? ` (${props.toggleShortcutLabel})` : ""}`}
            </TooltipPopup>
          </Tooltip>
        </div>
        {body}
      </div>
    </div>
  );
}

const AgentTabContent = memo(function AgentTabContent(props: {
  parentRef: ScopedThreadRef;
  tab: BottomPanelTab;
  agentSwitcher: ReactNode;
  selectedRunId: string | undefined;
  canOperate: boolean;
  visible: boolean;
  focusRequestId: number;
  resizeEpoch: number;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onStop: (entry: AgentTerminalEntry) => void;
}) {
  const { tab, parentRef } = props;
  const tabThreadRef = useMemo(
    () => scopeThreadRef(parentRef.environmentId, ThreadId.make(tab.threadId)),
    [parentRef.environmentId, tab.threadId],
  );
  const runs = tab.runs.length > 0 ? tab.runs : EMPTY_ENTRIES;
  const selected = resolveSelected(runs, props.selectedRunId);

  // Only a user request moves keyboard focus, and only into the run it was
  // made for: an agent starting a command never pulls it out of the composer.
  const [focusTarget, setFocusTarget] = useState<{ terminalId: string; token: number } | null>(
    null,
  );
  const focusRun = (terminalId: string) =>
    setFocusTarget((current) => ({ terminalId, token: (current?.token ?? 0) + 1 }));
  const [seenFocusRequestId, setSeenFocusRequestId] = useState(props.focusRequestId);
  if (props.focusRequestId !== seenFocusRequestId) {
    setSeenFocusRequestId(props.focusRequestId);
    if (selected) focusRun(selected.terminalId);
  }

  return (
    // Not keyed by tab, so the switcher stays put; AgentRunsView fades the new agent's runs in.
    <div className="@container/terminals flex min-h-0 min-w-0 flex-1 flex-col">
      <AgentRunsView
        threadRef={tabThreadRef}
        runs={runs}
        liveRunCount={tab.liveRunCount}
        selected={selected}
        canOperate={props.canOperate}
        visible={props.visible}
        focusToken={focusTarget?.token ?? 0}
        autoFocus={selected !== null && focusTarget?.terminalId === selected.terminalId}
        resizeEpoch={props.resizeEpoch}
        onSelect={(terminalId) =>
          useBottomPanelStore.getState().selectRun(parentRef, tab.id, terminalId)
        }
        onFocusOutput={() => {
          if (selected) focusRun(selected.terminalId);
        }}
        onStop={props.onStop}
        onAddTerminalContext={props.onAddTerminalContext}
        listHeader={props.agentSwitcher}
      />
    </div>
  );
});

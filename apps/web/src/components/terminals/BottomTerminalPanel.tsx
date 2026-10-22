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
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
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
  terminalRunState,
  type AgentTerminalEntry,
} from "../AgentTerminalsPanel.logic";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentRunsView } from "./AgentRunsView";
import {
  bottomPanelMaxHeight,
  bottomPanelTabs,
  bottomPanelToggleShowsActivity,
  clampBottomPanelHeight,
  findRunForToolCall,
  resolveActiveBottomPanelTab,
  type BottomPanelAgent,
  type BottomPanelTab,
} from "./bottomPanel.logic";
import { RunStateGlyph } from "./terminalParts";

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

function TabStatus({ tab }: { tab: BottomPanelTab }) {
  const newest = tab.runs[0];
  if (!newest) return null;
  // Keyed by state so a change fades in place (swap-motion).
  const state = terminalRunState(newest);
  return (
    <span key={state.kind} className="swap-motion flex shrink-0">
      <RunStateGlyph state={state} />
    </span>
  );
}

const AgentTabStrip = memo(function AgentTabStrip(props: {
  tabs: ReadonlyArray<BottomPanelTab>;
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onCloseTab: (tab: BottomPanelTab) => void;
}) {
  return (
    <div role="tablist" aria-label="Agents" className="flex min-w-0 flex-1 items-center gap-0.5">
      {props.tabs.map((tab) => {
        const active = tab.id === props.activeTabId;
        return (
          <div
            key={tab.id}
            className={cn(
              "group/agent-tab relative flex h-7 min-w-0 max-w-56 shrink items-center rounded-md transition-colors duration-(--motion-duration-fast) ease-out",
              active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              data-bottom-panel-tab={tab.id}
              onClick={() => props.onSelect(tab.id)}
              className="flex h-full min-w-0 items-center gap-1.5 rounded-md ps-2 pe-6 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              {tab.primary ? (
                <TerminalSquare aria-hidden className="size-3.5 shrink-0" />
              ) : (
                <Bot aria-hidden className="size-3.5 shrink-0" />
              )}
              <span className="min-w-0 truncate">{tab.title}</span>
              {tab.liveRunCount > 0 ? (
                <span className="shrink-0 text-2xs tabular-nums text-success">
                  {tab.liveRunCount}
                </span>
              ) : null}
              <TabStatus tab={tab} />
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title} tab`}
              onClick={() => props.onCloseTab(tab)}
              className={cn(
                "absolute end-1 flex size-4 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none transition-opacity duration-(--motion-duration-fast) ease-out hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset group-hover/agent-tab:opacity-100",
                active && "opacity-60",
              )}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
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
 * The resizable panel under the chat, as in T3 Code: one tab per agent that
 * ran commands, each showing that agent's command list and live output. It
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
          key={activeTab.id}
          parentRef={threadRef}
          tab={activeTab}
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
        "z-40 flex min-w-0 flex-col px-2",
        open ? "relative shrink-0" : "pointer-events-none absolute inset-x-0 bottom-0",
      )}
      style={{ height }}
    >
      <div
        className={cn(
          "group/bottom-panel relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-2xl border border-b-0 bg-card surface-raised dark:bg-surface-raised",
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
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 ps-2 pe-1.5 pt-1">
          <AgentTabStrip
            tabs={tabs}
            activeTabId={activeTab?.id ?? null}
            onSelect={selectTab}
            onCloseTab={closeTab}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Close panel"
                  onClick={() => useBottomPanelStore.getState().setOpen(threadRef, false)}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-(--motion-duration-fast) ease-out hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                />
              }
            >
              <X className="size-3.5" />
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
    // Keyed by tab: a tab switch fades the new agent's runs in.
    <div className="reveal-motion @container/terminals flex min-h-0 min-w-0 flex-1 flex-col">
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
      />
    </div>
  );
});

import { scopedThreadKey, scopeThreadRef } from "@cogenly/client-runtime/environment";
import {
  NodeId,
  resolveEnvironmentMachineKind,
  ThreadId,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type ProviderDriverKind,
  type ServerProvider,
} from "@cogenly/contracts";
import { canDetachThreadProviderSession } from "@cogenly/client-runtime/state/thread-workflows";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import {
  CornerLeftUpIcon,
  FolderOpenIcon,
  GitForkIcon,
  ListTreeIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PlusIcon,
  UnplugIcon,
} from "lucide-react";
import { Children, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { observeResize } from "~/lib/observeResize";
import { readPanelFlipShift } from "~/lib/panelFlip";
import { cn } from "~/lib/utils";
import {
  useProjects,
  useServerConfigs,
  useThreadProjection,
  useThreadShell,
  useThreadShells,
} from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { shellEnvironment } from "~/state/shell";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useThreadRunner } from "~/machines/useThreadRunner";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { StopGlyph } from "../StopGlyph";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "../preview/fileExplorerLabel";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import { useChatCanvas } from "./ChatCanvasContext";
import type { ChatCanvasDetailsCard } from "./chatCanvasLayout";
import { canDockThreadDetails } from "./threadDetailsDock.logic";
import { selectThreadDetailsDocked, useThreadDetailsDockStore } from "./threadDetailsDockStore";
import { resolveProviderInstanceAccentColors } from "../../providerInstances";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { DisclosurePanel, DisclosureTrigger } from "../ui/disclosure";
import { ThreadDetailsRow, ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadRelationshipIcon } from "./ThreadRelationshipIcon";
import {
  deriveThreadAgents,
  formatThreadAgentsHeading,
  resolveThreadAgentsWindow,
  THREAD_AGENTS_INITIAL_COUNT,
  THREAD_AGENTS_PAGE_COUNT,
  threadAgentDotTone,
  type ThreadAgentRow,
  type ThreadAgentsSummary,
  type ThreadAgentStopTarget,
  type ThreadAgentSubagentInput,
  type ThreadAgentThreadInput,
} from "./threadAgents.logic";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

function iso(value: DateTime.Utc | null | undefined): string | null {
  return value == null ? null : DateTime.formatIso(value);
}

function toSubagentInput(subagent: OrchestrationV2Subagent): ThreadAgentSubagentInput {
  return {
    id: subagent.id,
    threadId: subagent.threadId,
    origin: subagent.origin,
    driver: subagent.driver,
    providerInstanceId: subagent.providerInstanceId,
    childThreadId: subagent.childThreadId,
    runId: subagent.runId,
    hasStrongNativeTask:
      subagent.nativeTaskRef?.strength === "strong" && subagent.nativeTaskRef.nativeId !== null,
    title: subagent.title,
    prompt: subagent.prompt,
    status: subagent.status,
    startedAt: iso(subagent.startedAt),
    completedAt: iso(subagent.completedAt),
    updatedAt: DateTime.formatIso(subagent.updatedAt),
    ...(subagent.workflow === undefined
      ? {}
      : { workflow: { name: subagent.workflow.name ?? null, agents: subagent.workflow.agents } }),
  };
}

/** What the details show for a thread, for the popover and the docked card alike. */
function useThreadDetailsModel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const shell = useThreadShell(ref);
  const projection = useThreadProjection(ref)?.projection ?? null;
  const shells = useThreadShells();
  const summary = useMemo(() => {
    const threads: ThreadAgentThreadInput[] = shells
      .filter((thread) => thread.environmentId === props.environmentId && thread.deletedAt === null)
      .map(({ source }) => {
        const parentThreadId =
          source.forkedFrom?.type === "run"
            ? source.forkedFrom.threadId
            : source.lineage.parentThreadId;
        const live = source.activityRunStatus ?? null;
        return {
          id: source.id,
          title: source.title,
          providerInstanceId: source.providerInstanceId,
          parentThreadId,
          relationshipToParent: source.lineage.relationshipToParent,
          sourceThreadId: source.sourceThreadId ?? null,
          status: live ?? source.status,
          hasRun: live !== null || source.latestRunId !== null,
          startedAt: iso(live ? source.activityRunStartedAt : source.latestRunStartedAt),
          completedAt: live ? null : iso(source.latestRunCompletedAt),
          createdAt: DateTime.formatIso(source.createdAt),
        };
      });
    return deriveThreadAgents({
      threadId: props.threadId,
      subagents: (projection?.subagents ?? []).map(toSubagentInput),
      threads,
    });
  }, [projection?.subagents, props.environmentId, props.threadId, shells]);
  const canDetach = projection === null ? false : canDetachThreadProviderSession(projection);
  const label =
    summary.running > 0 ? `Thread details, ${summary.running} running` : "Thread details";
  return { ref, shell, summary, canDetach, label };
}

/**
 * The header's details button: where the thread runs, where it came from, and
 * the agents it spawned or handed work to directly, with the actions to open
 * or stop them. While the chat has room beside it (ThreadDetailsDock), the
 * button docks the details there and the chat slides over; otherwise it
 * opens them as a popover.
 */
export function ThreadDetailsMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const { ref, shell, summary, canDetach, label } = useThreadDetailsModel(props);
  // A popover left open does not follow the user to another thread.
  const threadKey = scopedThreadKey(ref);
  const [seenThreadKey, setSeenThreadKey] = useState(threadKey);
  if (seenThreadKey !== threadKey) {
    setSeenThreadKey(threadKey);
    setPopoverOpen(false);
  }
  const dockAvailable = useThreadDetailsDockStore((state) => state.available);
  const docked = useThreadDetailsDockStore(
    (state) => selectThreadDetailsDocked(state, ref) && state.available,
  );
  // The card takes over from a popover left open when room for it appears.
  const open = popoverOpen && !docked;
  const tooltip = dockAvailable ? `${docked ? "Hide" : "Show"} ${label.toLowerCase()}` : label;
  const buttonProps = {
    variant: "ghost-muted",
    size: "icon-sm",
    "aria-label": label,
    "data-thread-details-trigger": "",
    "data-pressed": open || docked ? "" : undefined,
    className: "relative shrink-0 [-webkit-app-region:no-drag]",
  } as const;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // With room to dock, the button toggles the card instead.
        if (dockAvailable) return;
        setPopoverOpen(next);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            dockAvailable ? (
              <Button
                {...buttonProps}
                aria-pressed={docked}
                onClick={() => {
                  setPopoverOpen(false);
                  useThreadDetailsDockStore.getState().setDocked(ref, !docked);
                }}
              />
            ) : (
              <PopoverTrigger render={<Button {...buttonProps} />} />
            )
          }
        >
          <ListTreeIcon className="size-4.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="bottom" align="end" collisionPadding={8} width="md" padding="none">
        {shell ? (
          <ThreadDetailsMenuContent
            environmentId={props.environmentId}
            threadId={props.threadId}
            summary={summary}
            canDetach={canDetach}
            onNavigate={() => setPopoverOpen(false)}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

/**
 * Thread details docked at the chat's top-right, for a user who keeps them
 * open (the header button) while the chat has room beside them. Rendered in
 * the ChatCanvas: it reports where it sits, and the canvas slides the chat
 * over to keep clear of it (chatCanvasLayout). The same content as the
 * popover; it fades in and out, and the chat glides with it.
 */
export function ThreadDetailsDock(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The find bar holds the top-right corner while it shows; the card sits under it. */
  readonly findOpen: boolean;
}) {
  const canvas = useChatCanvas();
  const available = canDockThreadDetails({
    canvasWidth: canvas?.container.width ?? 0,
    minChatWidth: canvas?.lane.minChatWidth ?? 0,
  });
  const setAvailable = useThreadDetailsDockStore((state) => state.setAvailable);
  useLayoutEffect(() => setAvailable(available), [available, setAvailable]);
  useLayoutEffect(() => () => setAvailable(false), [setAvailable]);
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const docked = useThreadDetailsDockStore((state) => selectThreadDetailsDocked(state, ref));
  const open = available && docked;
  // Stays mounted while it fades out after closing. Only a card the user
  // opens here fades in; one already open when the chat loads, or in the
  // thread the user switched to, just shows, and a switch away just hides it.
  const [present, setPresent] = useState(open);
  const [fadeIn, setFadeIn] = useState(false);
  const threadKey = scopedThreadKey(ref);
  const [seenThreadKey, setSeenThreadKey] = useState(threadKey);
  if (seenThreadKey !== threadKey) {
    setSeenThreadKey(threadKey);
    setPresent(open);
    setFadeIn(false);
  } else if (open && !present) {
    setPresent(true);
    setFadeIn(true);
  }
  if (!present) return null;
  return (
    <ThreadDetailsDockCard
      {...props}
      open={open}
      fadeIn={fadeIn}
      onClosed={() => setPresent(false)}
      reportDetailsCard={canvas?.reportDetailsCard ?? null}
    />
  );
}

function ThreadDetailsDockCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly findOpen: boolean;
  readonly open: boolean;
  readonly fadeIn: boolean;
  readonly onClosed: () => void;
  readonly reportDetailsCard: ((card: ChatCanvasDetailsCard | null) => void) | null;
}) {
  const { ref, shell, summary, canDetach } = useThreadDetailsModel(props);
  const cardRef = useRef<HTMLElement | null>(null);
  const { open, reportDetailsCard } = props;
  // Reported only while open, so the chat glides back as the card fades out.
  useLayoutEffect(() => {
    const card = cardRef.current;
    const canvas = card?.closest<HTMLElement>("[data-chat-canvas]");
    if (!reportDetailsCard || !card || !canvas || !open) {
      reportDetailsCard?.(null);
      return;
    }
    const report = () => {
      const rect = card.getBoundingClientRect();
      const origin = canvas.getBoundingClientRect();
      // As laid out: a resize during a panel toggle lands while the card's own
      // glide still draws it elsewhere, and the chat must not make room for that.
      const glide = readPanelFlipShift(card) - readPanelFlipShift(canvas);
      reportDetailsCard({
        left: Math.round(rect.left - glide - origin.left),
        right: Math.round(rect.right - glide - origin.left),
        bottom: Math.round(rect.bottom - origin.top),
      });
    };
    report();
    const stop = observeResize([card, canvas], report);
    return () => {
      stop();
      reportDetailsCard(null);
    };
  }, [open, reportDetailsCard]);
  return (
    <aside
      ref={cardRef}
      aria-label="Thread details"
      inert={!open}
      data-panel-flip="end"
      // Opens and closes like the popover it replaces: a fade from 97% scale
      // about the corner under the header button. It never slides, so the
      // chat lane's glide (ChatCanvas) is the only thing that moves.
      data-popup-enter={props.fadeIn ? "" : undefined}
      data-ending-style={open ? undefined : ""}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        useThreadDetailsDockStore.getState().setDocked(ref, false);
        document.querySelector<HTMLElement>("[data-thread-details-trigger]")?.focus();
      }}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !open) props.onClosed();
      }}
      className={cn(
        "dropdown-glass surface-raised surface-raised-floating absolute right-3 z-30 flex max-h-[min(36rem,calc(100%-12rem))] w-(--thread-details-panel-width) flex-col overflow-hidden rounded-lg text-popover-foreground",
        "origin-top-right popup-motion transition-[opacity,scale,top]",
        props.findOpen ? "top-14" : "top-3",
        !open && "pointer-events-none",
      )}
    >
      <div className="scroll-fade-y min-h-0 overflow-y-auto overscroll-contain">
        {shell ? (
          <ThreadDetailsMenuContent
            environmentId={props.environmentId}
            threadId={props.threadId}
            summary={summary}
            canDetach={canDetach}
            onNavigate={() => {}}
          />
        ) : null}
      </div>
    </aside>
  );
}

function ThreadDetailsMenuContent(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly summary: ThreadAgentsSummary;
  readonly canDetach: boolean;
  readonly onNavigate: () => void;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const shell = useThreadShell(ref);
  const serverConfig = useServerConfigs().get(props.environmentId);
  const project = useProjects().find(
    (candidate) =>
      candidate.environmentId === props.environmentId && candidate.id === shell?.projectId,
  );
  const navigate = useNavigate();
  const revealInFileManager = useAtomCommand(shellEnvironment.revealInFileManager, {
    reportFailure: false,
  });
  const source = shell?.source;
  const runner = useThreadRunner(props.environmentId, source?.ownerMachine);

  const openThread = (threadId: string) => {
    props.onNavigate();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, ThreadId.make(threadId))),
    });
  };

  const workspacePath = shell?.worktreePath ?? project?.workspaceRoot ?? null;
  const revealLabel =
    serverConfig?.shellRevealInFileManager === true
      ? serverConfig.shellRevealInFileManagerKind === undefined
        ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os)
        : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind)
      : null;
  const reveal = async () => {
    if (workspacePath === null) return;
    const result = await revealInFileManager({
      environmentId: props.environmentId,
      input: { path: workspacePath },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Unable to reveal folder",
        description: workspacePath,
      });
    }
  };

  // Lineage: where this thread came from.
  const parentThreadId =
    source?.forkedFrom?.type === "run"
      ? source.forkedFrom.threadId
      : (source?.lineage.parentThreadId ?? null);
  const sourceThreadId = source?.sourceThreadId ?? null;
  const parentShell = useThreadShell(
    parentThreadId === null ? null : scopeThreadRef(props.environmentId, parentThreadId),
  );
  const sourceShell = useThreadShell(
    sourceThreadId === null ? null : scopeThreadRef(props.environmentId, sourceThreadId),
  );
  const lineageLinks: Array<{
    key: string;
    icon: ReactNode;
    prefix: string;
    title: string | null;
    threadId: string;
  }> = [];
  if (sourceThreadId !== null && sourceThreadId !== props.threadId) {
    lineageLinks.push({
      key: "source",
      icon: <MessageSquareIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />,
      prefix: source?.workOrigin === "agent" ? "From agent conversation" : "From chat",
      title: sourceShell?.title ?? null,
      threadId: sourceThreadId,
    });
  }
  if (parentThreadId !== null && parentThreadId !== sourceThreadId) {
    const isFork = source?.lineage.relationshipToParent !== "subagent";
    lineageLinks.push({
      key: "parent",
      icon: isFork ? (
        <GitForkIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      ) : (
        <CornerLeftUpIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      ),
      prefix: isFork ? "Forked from" : "Parent agent",
      title: parentShell?.title ?? null,
      threadId: parentThreadId,
    });
  }

  return (
    <div className="flex flex-col">
      <ThreadDetailsSection
        headingId="thread-details-machine-heading"
        title="Machine"
        separated={false}
      >
        {/* The machine that runs the thread, which for a replica is another
            paired machine. The chat header does not name it. */}
        <ThreadDetailsRow
          icon={
            <EnvironmentMachineIcon
              kind={runner?.kind ?? resolveEnvironmentMachineKind(serverConfig ?? null)}
              className={THREAD_DETAILS_PANEL_ICON_CLASS}
            />
          }
          label={runner?.name ?? serverConfig?.environment.label ?? "This machine"}
          secondary={runner?.online === false ? "offline" : null}
        />
        {revealLabel !== null && workspacePath !== null ? (
          <Tooltip>
            <TooltipTrigger
              delay={300}
              render={
                <ThreadDetailsRow
                  icon={<FolderOpenIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />}
                  label={revealLabel}
                  onClick={() => void reveal()}
                />
              }
            />
            <TooltipPopup side="left">{workspacePath}</TooltipPopup>
          </Tooltip>
        ) : null}
      </ThreadDetailsSection>
      {lineageLinks.length > 0 || props.summary.total > 0 ? (
        <ThreadLineageSection
          environmentId={props.environmentId}
          threadId={props.threadId}
          summary={props.summary}
          canDetach={props.canDetach}
          onOpenThread={openThread}
        >
          {lineageLinks.map((link) => (
            <li key={link.key} className="m-0 list-none p-0">
              <ThreadDetailsRow
                icon={link.icon}
                label={link.prefix}
                secondary={link.title}
                onClick={() => openThread(link.threadId)}
              />
            </li>
          ))}
        </ThreadLineageSection>
      ) : null}
    </div>
  );
}

const ROW_STOP_REVEAL_CLASS =
  "pointer-events-none absolute end-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-(--motion-duration-fast) ease-out group-hover/agent:pointer-events-auto group-hover/agent:opacity-100 group-focus-within/agent:pointer-events-auto group-focus-within/agent:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100";
const ROW_TRAILING_HIDE_CLASS =
  "transition-opacity duration-(--motion-duration-fast) ease-out group-hover/agent:opacity-0 group-focus-within/agent:opacity-0 pointer-coarse:opacity-0";

/**
 * Lineage, after T3 Code's thread relationships panel: where this thread came
 * from, then its direct agents that are running now, then every settled one
 * folded under "Previous agents (N)" with its failed count. Each list shows a
 * page at a time.
 */
/**
 * Renders an agent row (provider glyph and status dot, title, elapsed time,
 * hover stop) with its own stop state. The Lineage section and the composer's
 * "Waiting on subagents" strip share it, so both lists look and act the same.
 */
function useThreadAgentRowRenderer(props: {
  readonly environmentId: EnvironmentId;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const [stoppingKey, setStoppingKey] = useState<string | null>(null);
  const providers = useServerConfigs().get(props.environmentId)?.providers;
  const markColorByInstanceId = useMemo(
    () => resolveProviderInstanceAccentColors(providers ?? []),
    [providers],
  );
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const stopWorkflow = useAtomCommand(orchestrationEnvironment.stopWorkflow, {
    reportFailure: false,
  });

  const stop = async (row: ThreadAgentRow, target: ThreadAgentStopTarget) => {
    if (stoppingKey !== null) return;
    setStoppingKey(row.key);
    const result =
      target.type === "workflow"
        ? await stopWorkflow({
            environmentId: props.environmentId,
            input: {
              threadId: ThreadId.make(target.threadId),
              subagentId: NodeId.make(target.subagentId),
            },
          })
        : await interruptTurn({
            environmentId: props.environmentId,
            input:
              target.type === "subagent"
                ? {
                    threadId: ThreadId.make(target.threadId),
                    subagentId: NodeId.make(target.subagentId),
                  }
                : { threadId: ThreadId.make(target.threadId) },
          });
    setStoppingKey(null);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: `Could not stop ${row.title}` });
    }
  };

  return (row: ThreadAgentRow) => (
    <ThreadAgentListRow
      key={row.key}
      row={row}
      providers={providers}
      accentColor={markColorByInstanceId.get(row.providerInstanceId ?? "")}
      stopping={stoppingKey === row.key}
      stopDisabled={stoppingKey !== null}
      onStop={(target) => void stop(row, target)}
      onOpenThread={props.onOpenThread}
    />
  );
}

/**
 * A thread's running direct agents as Lineage rows, for the composer's
 * "Waiting on subagents" strip. Renders nothing while none are running.
 */
export function ThreadRunningAgentsList(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { summary } = useThreadDetailsModel(props);
  const renderRow = useThreadAgentRowRenderer(props);
  if (summary.active.length === 0) return null;
  return (
    <ul aria-label="Running agents" className="m-0 list-none p-0">
      {summary.active.map(renderRow)}
    </ul>
  );
}

function ThreadLineageSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly summary: ThreadAgentsSummary;
  readonly canDetach: boolean;
  readonly onOpenThread: (threadId: string) => void;
  readonly children: ReactNode;
}) {
  const [detaching, setDetaching] = useState(false);
  const stopSession = useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
  const { summary } = props;
  const renderRow = useThreadAgentRowRenderer(props);

  const detach = async () => {
    if (detaching) return;
    setDetaching(true);
    const result = await stopSession({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    });
    setDetaching(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not disconnect the agent session" });
    }
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-lineage-heading"
      title={formatThreadAgentsHeading(summary)}
      actions={
        props.canDetach ? (
          <Menu>
            <MenuTrigger
              render={
                <ThreadDetailsControl
                  part="icon"
                  aria-label="More thread actions"
                  disabled={detaching}
                />
              }
            >
              <MoreHorizontalIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => void detach()}>
                <UnplugIcon />
                Disconnect agent session
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : undefined
      }
    >
      {Children.count(props.children) > 0 ? (
        <ul aria-label="Related threads" className="m-0 list-none p-0">
          {props.children}
        </ul>
      ) : null}
      <ThreadAgentsGroup label={null} rows={summary.active} failed={0}>
        {renderRow}
      </ThreadAgentsGroup>
      <ThreadAgentsGroup label="Previous agents" rows={summary.previous} failed={summary.failed}>
        {renderRow}
      </ThreadAgentsGroup>
    </ThreadDetailsSection>
  );
}

/**
 * One list of agents, a page at a time. With a label it starts folded behind a
 * header: the label (with the count while folded), a hairline, the failed
 * count and the disclosure chevron.
 */
function ThreadAgentsGroup(props: {
  readonly label: string | null;
  readonly rows: ReadonlyArray<ThreadAgentRow>;
  readonly failed: number;
  readonly children: (row: ThreadAgentRow) => ReactNode;
}) {
  const [open, setOpen] = useState(props.label === null);
  const [visibleCount, setVisibleCount] = useState(THREAD_AGENTS_INITIAL_COUNT);
  if (props.rows.length === 0) return null;
  const { visible, hiddenCount } = resolveThreadAgentsWindow(props.rows, visibleCount);
  const list = (
    <>
      <ul
        aria-label={props.label ?? "Running agents"}
        className="scroll-fade-y m-0 max-h-[13.5rem] list-none overflow-y-auto overscroll-contain p-0 has-data-workflow-open:max-h-[min(28rem,55dvh)]"
      >
        {visible.map(props.children)}
      </ul>
      {hiddenCount > 0 ? (
        <ThreadDetailsControl
          part="row"
          tone="muted"
          onClick={() => setVisibleCount((count) => count + THREAD_AGENTS_PAGE_COUNT)}
        >
          <PlusIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          Show {Math.min(hiddenCount, THREAD_AGENTS_PAGE_COUNT)} more
        </ThreadDetailsControl>
      ) : null}
    </>
  );
  if (props.label === null) return list;
  return (
    <div>
      {/* The header takes this type; the trigger inherits it. */}
      <div className="flex px-2.5 text-2xs font-medium text-muted-foreground">
        <DisclosureTrigger open={open} onClick={() => setOpen(!open)} className="h-8 flex-1">
          <span className="shrink-0">
            {props.label}
            {open ? null : <span className="tabular-nums"> ({props.rows.length})</span>}
          </span>
          <span aria-hidden className="mx-0.5 h-px min-w-2 flex-1 bg-border/65" />
          {props.failed > 0 ? (
            <span className="shrink-0 text-destructive-foreground tabular-nums">
              {props.failed} failed
            </span>
          ) : null}
        </DisclosureTrigger>
      </div>
      <DisclosurePanel open={open}>{list}</DisclosurePanel>
    </div>
  );
}

/**
 * An agent's row: its provider glyph with a status dot, the title, then the
 * elapsed time (or "Failed"). Hovering a stoppable agent swaps the time for a
 * stop button. A workflow row expands to its own agents.
 */
function ThreadAgentListRow(props: {
  readonly row: ThreadAgentRow;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly accentColor: string | undefined;
  readonly stopping: boolean;
  readonly stopDisabled: boolean;
  readonly onStop: (target: ThreadAgentStopTarget) => void;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { row } = props;
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const provider = props.providers?.find((entry) => entry.instanceId === row.providerInstanceId);
  const driver = (row.driver ?? provider?.driver ?? null) as ProviderDriverKind | null;
  const failed = row.status === "failed";
  const relativeAt = row.completedAt ?? row.sortAt;
  const when =
    row.status === "running"
      ? row.startedAt === null
        ? row.statusLabel
        : `${row.statusLabel}, started ${formatRelativeTimeLabel(row.startedAt)}`
      : `${row.status === "done" ? (row.statusLabel === "Idle" ? "Idle" : "Finished") : row.statusLabel} ${formatRelativeTimeLabel(relativeAt)}`;
  const hasElapsed = row.startedAt !== null;
  const { stop: stopTarget, threadId } = row;
  const trailing = failed ? (
    <span className={cn("shrink-0 text-2xs font-normal text-destructive", ROW_TRAILING_HIDE_CLASS)}>
      Failed
    </span>
  ) : hasElapsed ? (
    <span
      className={cn(
        "shrink-0 text-2xs font-normal text-muted-foreground tabular-nums",
        stopTarget !== null && ROW_TRAILING_HIDE_CLASS,
      )}
    >
      <AgentElapsed
        agent={{
          status: row.status === "running" ? "running" : "completed",
          startedAt: row.startedAt,
          completedAt: row.completedAt,
        }}
        compact
      />
    </span>
  ) : row.status === "running" ? (
    <span
      className={cn(
        "shrink-0 text-2xs font-normal text-muted-foreground",
        stopTarget !== null && ROW_TRAILING_HIDE_CLASS,
      )}
    >
      {row.statusLabel}
    </span>
  ) : null;
  const rowProps = {
    icon: (
      <ThreadRelationshipIcon
        driver={driver}
        provider={provider}
        accentColor={props.accentColor}
        tone={threadAgentDotTone(row)}
      />
    ),
    label: row.title,
    trailing,
    "aria-description": row.statusLabel,
  };
  const isWorkflow = row.members.length > 0;
  return (
    <li
      className="group/agent relative m-0 list-none p-0"
      data-workflow-open={workflowOpen ? "" : undefined}
    >
      <Tooltip>
        {/* When it ran lives in the tooltip, so the row only carries the duration. */}
        <TooltipTrigger
          delay={300}
          render={
            isWorkflow ? (
              <ThreadDetailsRow
                {...rowProps}
                aria-expanded={workflowOpen}
                onClick={() => setWorkflowOpen(!workflowOpen)}
              />
            ) : threadId !== null ? (
              <ThreadDetailsRow
                {...rowProps}
                aria-label={`Open ${row.title}`}
                onClick={() => props.onOpenThread(threadId)}
              />
            ) : (
              <ThreadDetailsRow {...rowProps} render={<div />} />
            )
          }
        />
        <TooltipPopup side="left">{when}</TooltipPopup>
      </Tooltip>
      {stopTarget !== null ? (
        <div className={ROW_STOP_REVEAL_CLASS}>
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  part="icon"
                  tone="destructive"
                  aria-label={`Stop ${row.title}`}
                  disabled={props.stopDisabled}
                  onClick={() => props.onStop(stopTarget)}
                />
              }
            >
              {props.stopping ? (
                <Spinner size="sm" aria-hidden />
              ) : (
                <StopGlyph className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="left">Stop</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      {isWorkflow ? (
        <DisclosurePanel open={workflowOpen}>
          <ul aria-label={`${row.title} agents`} className="m-0 list-none p-0 ps-4">
            {row.members.map((member) => (
              <ThreadAgentListRow
                key={member.key}
                row={member}
                providers={props.providers}
                accentColor={props.accentColor}
                stopping={false}
                stopDisabled
                onStop={() => {}}
                onOpenThread={props.onOpenThread}
              />
            ))}
          </ul>
        </DisclosurePanel>
      ) : null}
    </li>
  );
}

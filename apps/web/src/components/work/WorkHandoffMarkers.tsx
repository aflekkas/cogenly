import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type {
  EnvironmentId,
  MessageId,
  OrchestrationV2Notification,
  ThreadId,
  WorkHandoffLink,
  WorkTask,
} from "@t3tools/contracts";
import { ChevronRightIcon, GitBranchIcon, HammerIcon } from "lucide-react";
import { createContext, use, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useProjects, useServerConfigs, useThreadShell } from "~/state/entities";
import type { MessagesTimelineRow } from "../chat/MessagesTimeline.logic";
import { resolveThreadOrigin } from "../chat/threadLineage.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { BadgeDot, type BadgeDotTone } from "../ui/badge-dot";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveWorkHandoffStatus,
  workNotificationStatus,
  type WorkHandoffAnchors,
  type WorkHandoffStatus,
} from "./work.logic";
import { changeFade, useChangedSinceMount, WorkTaskCard } from "./WorkTaskCard";
import type { WorkTaskAnchors } from "./workTask.logic";

interface WorkHandoffMarkersState {
  readonly environmentId: EnvironmentId;
  readonly anchors: WorkHandoffAnchors;
  /** The chat's task cards, when it has any. */
  readonly tasks: { readonly chatThreadId: ThreadId; readonly anchors: WorkTaskAnchors } | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}

const NO_HANDOFFS: WorkHandoffAnchors = { byMessageId: new Map(), unanchored: [] };

const WorkHandoffMarkersCtx = createContext<WorkHandoffMarkersState | null>(null);

/** Gives the chat timeline's rows the Work and task cards this chat handed off, by anchor message. */
export function WorkHandoffMarkersProvider(props: {
  readonly environmentId: EnvironmentId | null;
  readonly anchors: WorkHandoffAnchors | null;
  readonly tasks: WorkHandoffMarkersState["tasks"];
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly children: ReactNode;
}) {
  const { environmentId, anchors, tasks, onOpenThread } = props;
  const value = useMemo(
    () =>
      environmentId === null || (anchors === null && tasks === null)
        ? null
        : { environmentId, anchors: anchors ?? NO_HANDOFFS, tasks, onOpenThread },
    [anchors, environmentId, onOpenThread, tasks],
  );
  return <WorkHandoffMarkersCtx value={value}>{props.children}</WorkHandoffMarkersCtx>;
}

/**
 * The message a timeline row ends, when markers may follow it: a user
 * message, or an assistant reply where its actions row (Start Work) sits.
 * Commentary mid-turn, and a reply whose actions moved below its tool calls,
 * end nothing here.
 */
function rowEndsMessage(row: MessagesTimelineRow): MessageId | null {
  if (row.kind === "assistant-meta") return row.message.id;
  if (row.kind !== "message") return null;
  if (row.message.role === "user") return row.message.id;
  return row.message.role === "assistant" && row.showAssistantMeta ? row.message.id : null;
}

/** The tasks and Work started from the message this row ends: task cards, then markers. */
export function WorkHandoffMarkersAfterRow(props: { readonly row: MessagesTimelineRow }) {
  const state = use(WorkHandoffMarkersCtx);
  const messageId = rowEndsMessage(props.row);
  if (!state || messageId === null) return null;
  const tasks = state.tasks?.anchors.byMessageId.get(messageId);
  const links = state.anchors.byMessageId.get(messageId);
  if (!tasks && !links) return null;
  return (
    <>
      {tasks ? <WorkTaskCardList tasks={tasks} state={state} /> : null}
      {links ? <WorkHandoffMarkerList links={links} state={state} /> : null}
    </>
  );
}

/** Tasks and handoffs with no message to sit beside, after the last message. */
export function UnanchoredWorkHandoffMarkers() {
  const state = use(WorkHandoffMarkersCtx);
  const tasks = state?.tasks?.anchors.unanchored ?? [];
  if (!state || (state.anchors.unanchored.length === 0 && tasks.length === 0)) return null;
  return (
    <div className="chat-content-lane pb-2">
      {tasks.length === 0 ? null : <WorkTaskCardList tasks={tasks} state={state} />}
      {state.anchors.unanchored.length === 0 ? null : (
        <WorkHandoffMarkerList links={state.anchors.unanchored} state={state} />
      )}
    </div>
  );
}

function WorkTaskCardList(props: {
  readonly tasks: ReadonlyArray<WorkTask>;
  readonly state: WorkHandoffMarkersState;
}) {
  const chatThreadId = props.state.tasks?.chatThreadId;
  if (chatThreadId === undefined) return null;
  return (
    <div className="flex flex-col gap-2 pt-3">
      {props.tasks.map((task) => (
        <WorkTaskCard
          key={task.id}
          environmentId={props.state.environmentId}
          chatThreadId={chatThreadId}
          task={task}
          onOpenThread={props.state.onOpenThread}
        />
      ))}
    </div>
  );
}

function WorkHandoffMarkerList(props: {
  readonly links: ReadonlyArray<WorkHandoffLink>;
  readonly state: WorkHandoffMarkersState;
}) {
  return (
    <div className="flex flex-col gap-2 pt-3">
      {props.links.map((link) => (
        <WorkHandoffMarker
          key={link.threadId}
          environmentId={props.state.environmentId}
          link={link}
          onOpenThread={props.state.onOpenThread}
        />
      ))}
    </div>
  );
}

/**
 * The Work thread's "From chat" detail: the source chat's title, plus how many
 * of its messages the handoff carried when the server recorded it.
 */
export function formatWorkHandoffSourceDetail(
  title: string,
  messagesCarried: number | null | undefined,
): string {
  if (messagesCarried === null || messagesCarried === undefined) return title;
  return `${title} · ${messagesCarried} ${messagesCarried === 1 ? "message" : "messages"}`;
}

/** The status dot's colour and the words for it, in the subagent rows' language. */
const STATUS_VISUAL: Record<
  WorkHandoffStatus,
  { readonly tone: BadgeDotTone; readonly label: string; readonly className?: string }
> = {
  running: { tone: "info", label: "Running" },
  waiting: { tone: "warning", label: "Waiting for you", className: "text-warning-foreground" },
  done: { tone: "success", label: "Done" },
  failed: { tone: "destructive", label: "Failed", className: "text-destructive" },
  stopped: { tone: "muted", label: "Stopped" },
};

/** The Work agent's avatar: its mark on a round tile, with the status dot in the corner. */
function WorkAvatar({ status }: { readonly status: WorkHandoffStatus | null }) {
  return (
    <span
      aria-hidden
      className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted"
    >
      <HammerIcon className="size-3.5 text-secondary-label" />
      <BadgeDot
        tone={status ? STATUS_VISUAL[status].tone : null}
        size="md"
        ring="background"
        className="absolute -right-px -bottom-px"
      />
    </span>
  );
}

/** Whether a thread is a Work session handed off from a chat or an agent conversation. */
export function isWorkHandoffThread(source: Parameters<typeof resolveThreadOrigin>[0]): boolean {
  const origin = resolveThreadOrigin(source);
  return origin?.kind === "chat" || origin?.kind === "agent-conversation";
}

/** Report ids already shown, so history and virtualized remounts never replay the fade. */
const shownWorkReportIds = new Set<string>();
const WORK_REPORT_ENTER_WINDOW_MS = 10_000;

/**
 * A Work session this chat handed off reporting back, drawn as the handoff
 * card's final state: "Work reported back" with the status it reported then
 * and the session's title. The task or handoff card higher up keeps the live
 * state and the repository, so this card leaves them out. The whole card opens
 * the session. Only a report that just arrived fades in.
 */
export function WorkReportCard(props: {
  readonly entryId: string;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly outcome: OrchestrationV2Notification["outcome"];
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const [entering] = useState(() => {
    if (shownWorkReportIds.has(props.entryId)) return false;
    shownWorkReportIds.add(props.entryId);
    return Date.now() - Date.parse(props.createdAt) < WORK_REPORT_ENTER_WINDOW_MS;
  });
  const status = workNotificationStatus(props.outcome);
  return (
    <WorkHandoffCardFrame
      threadId={props.threadId}
      title={props.title}
      status={status}
      onOpenThread={props.onOpenThread}
      className={entering ? "swap-motion" : undefined}
    >
      <WorkHandoffCardContent heading="Work reported back" status={status} title={props.title} />
    </WorkHandoffCardFrame>
  );
}

/**
 * The card that says this chat handed work off to a Work session here, drawn
 * like a subagent: the Work avatar with its status dot, the session's live
 * title, and its repository and branch. The whole card opens the session; the
 * Work thread links back with "From chat".
 */
function WorkHandoffMarker(props: {
  readonly environmentId: EnvironmentId;
  readonly link: WorkHandoffLink;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { environmentId, link } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, link.threadId),
    [environmentId, link.threadId],
  );
  const thread = useThreadShell(threadRef);
  const projects = useProjects();
  const scratchWorkspaceRoot = useServerConfigs().get(environmentId)?.scratchWorkspaceRoot;
  const project = projects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === thread?.projectId,
  );
  const repository =
    project === undefined ||
    project.isScratch === true ||
    isScratchProject(project, scratchWorkspaceRoot)
      ? null
      : project;
  const status = thread ? deriveWorkHandoffStatus(thread) : null;
  const title = thread?.title || link.title;
  const branch = repository ? thread?.branch : null;

  return (
    <WorkHandoffCardFrame
      threadId={link.threadId}
      title={title}
      status={status}
      onOpenThread={props.onOpenThread}
    >
      <WorkHandoffCardContent
        heading="Handed off to Work"
        status={status}
        title={title}
        location={{
          repository,
          label: repository?.title ?? "No repository",
          branch: branch ?? null,
        }}
      />
    </WorkHandoffCardFrame>
  );
}

/** The handoff card's frame: the whole card is the button that opens the Work session. */
function WorkHandoffCardFrame(props: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly status: WorkHandoffStatus | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  const { threadId, title, status } = props;
  return (
    <Tooltip>
      <TooltipTrigger
        delay={300}
        render={
          <button
            type="button"
            data-work-handoff=""
            aria-label={`Open Work: ${title}`}
            aria-description={status ? STATUS_VISUAL[status].label : undefined}
            onClick={() => props.onOpenThread(threadId)}
            className={cn(
              "group/work-handoff flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-xl border border-border bg-background px-3 py-2 text-left state-hover state-fade focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
              props.className,
            )}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{title}</TooltipPopup>
    </Tooltip>
  );
}

function WorkHandoffCardContent(props: {
  readonly heading: string;
  readonly status: WorkHandoffStatus | null;
  readonly title: string;
  /** The repository and branch line; left out where a card above already shows it. */
  readonly location?: {
    readonly repository: Parameters<typeof ProjectFavicon>[0]["project"] | null;
    readonly label: string;
    readonly branch: string | null;
  };
}) {
  const { status, title, location } = props;
  const statusChanged = useChangedSinceMount(status);
  const visual = status ? STATUS_VISUAL[status] : null;
  return (
    <>
      <WorkAvatar status={status} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          <span className="shrink-0">{props.heading}</span>
          {visual ? (
            <>
              <span aria-hidden className="shrink-0">
                ·
              </span>
              {/* Keyed so a live status change fades the new label in; history paints still. */}
              <span
                key={status}
                className={cn("min-w-0 truncate", visual.className, statusChanged && changeFade)}
              >
                {visual.label}
              </span>
            </>
          ) : null}
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{title}</span>
        {location ? (
          <span className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
            {location.repository ? (
              <ProjectFavicon project={location.repository} className="size-3 shrink-0" />
            ) : null}
            <span className="min-w-0 truncate">{location.label}</span>
            {location.branch ? (
              <>
                <GitBranchIcon aria-hidden className="ms-1 size-3 shrink-0" />
                <span className="min-w-0 shrink-[2] truncate">{location.branch}</span>
              </>
            ) : null}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden
        className="flex shrink-0 items-center gap-0.5 text-2xs text-muted-foreground transition-colors duration-(--motion-duration-fast) ease-out group-hover/work-handoff:text-foreground"
      >
        Open
        <ChevronRightIcon className="size-3.5" />
      </span>
    </>
  );
}

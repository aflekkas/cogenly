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
import { CheckIcon, CircleAlertIcon, CircleSlashIcon, HammerIcon } from "lucide-react";
import { createContext, use, useMemo, type ReactNode } from "react";

import { useProjects, useServerConfigs, useThreadShell } from "~/state/entities";
import type { MessagesTimelineRow } from "../chat/MessagesTimeline.logic";
import { resolveThreadOrigin } from "../chat/threadLineage.logic";
import { WorkLogRow } from "../chat/WorkLog";
import { ProjectFavicon } from "../ProjectFavicon";
import { InlineButton } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  deriveWorkHandoffStatus,
  type WorkHandoffAnchors,
  type WorkHandoffStatus,
} from "./work.logic";
import { WorkTaskCard } from "./WorkTaskCard";
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
    <div className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width) pb-2">
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
    <div className="pt-1">
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

const STATUS_LABEL: Record<WorkHandoffStatus, string> = {
  running: "Running",
  attention: "Needs attention",
  done: "Done",
  stopped: "Stopped",
};

function WorkHandoffStatusIcon({ status }: { readonly status: WorkHandoffStatus | null }) {
  switch (status) {
    case "running":
      return <Spinner size="xs" tone="muted" aria-hidden />;
    case "attention":
      return <CircleAlertIcon aria-hidden className="size-3 shrink-0 text-warning" />;
    case "done":
      return <CheckIcon aria-hidden className="size-3 shrink-0 text-success" />;
    case "stopped":
      return <CircleSlashIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />;
    case null:
      return null;
  }
}

/** Whether a thread is a Work session handed off from a chat or an agent conversation. */
export function isWorkHandoffThread(source: Parameters<typeof resolveThreadOrigin>[0]): boolean {
  const origin = resolveThreadOrigin(source);
  return origin?.kind === "chat" || origin?.kind === "agent-conversation";
}

const NOTIFICATION_OUTCOME_VERB: Record<OrchestrationV2Notification["outcome"], string> = {
  completed: "finished",
  failed: "failed",
  cancelled: "stopped",
  updated: "updated",
  unknown: "finished",
};

/** The chat's note that a Work session it handed off reported back, e.g. `Work "X" finished`. */
export function workNotificationLabel(
  title: string,
  outcome: OrchestrationV2Notification["outcome"],
): string {
  return `Work "${title}" ${NOTIFICATION_OUTCOME_VERB[outcome]}`;
}

/**
 * The timeline row that says this chat continued as a Work session here: the
 * session's live title, its repository and status, drawn like every other
 * timeline event. "Open Work" opens it; the Work thread links back with
 * "From chat".
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
  const repositoryLabel = repository?.title ?? "No repository";

  return (
    <WorkLogRow
      data-work-handoff=""
      icon={<HammerIcon aria-hidden className="size-4 text-icon-muted" />}
      label={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">Continued in Work</span>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          {status ? (
            // Keyed by status: a Work finishing fades its new icon in place.
            <span
              key={status}
              role="img"
              aria-label={STATUS_LABEL[status]}
              className="flex shrink-0 items-center swap-motion"
            >
              <WorkHandoffStatusIcon status={status} />
            </span>
          ) : null}
          <span className="min-w-0 truncate font-medium text-foreground/80">{title}</span>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <span className="flex min-w-0 shrink-[2] items-center gap-1 text-muted-foreground">
            {repository ? (
              <ProjectFavicon project={repository} className="size-3.5 shrink-0" />
            ) : null}
            <span className="min-w-0 truncate">{repositoryLabel}</span>
          </span>
        </span>
      }
      trailing={
        <InlineButton
          aria-label={`Open Work: ${title}`}
          onClick={() => props.onOpenThread(link.threadId)}
        >
          Open Work
        </InlineButton>
      }
    />
  );
}

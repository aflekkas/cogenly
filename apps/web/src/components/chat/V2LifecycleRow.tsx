import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { AgentElapsed } from "./AgentElapsed";
import { projectedSubagentsToRuntime } from "@cogenly/client-runtime/state/subagentRuntime";
import { notificationChildThreadId } from "@cogenly/client-runtime/state/thread-execution";
import { createContext, use, useMemo, useState, type ReactNode } from "react";
import { useThreadShell, useProject } from "../../state/entities";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopeProjectRef } from "@cogenly/client-runtime/environment";
import { environmentThreadDetails } from "../../state/threads";
import * as DateTime from "effect/DateTime";
import { WorkLogRow } from "./WorkLog";
import { BadgeDot } from "../ui/badge-dot";
import { MiddleTruncate } from "../ui/middle-truncate";
import {
  latestSubagentForChild,
  subagentResumedSince,
  subagentRowLines,
  subagentStatusVisual,
} from "./subagentRow.logic";
import {
  pendingSubagentCompletions,
  type PendingCompletionOutcome,
} from "./pendingSubagentCompletions.logic";
import {
  resolveHandoffEndpoints,
  type HandoffEndpoints,
  type HandoffTimelineRun,
} from "@cogenly/client-runtime/handoff";
import { formatSubagentDisplayTitle } from "@cogenly/client-runtime/state/subagent-display";
import {
  ProviderDriverKind,
  type OrchestrationV2Notification,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Subagent,
  type ProviderInstanceId,
  type ServerProvider,
  type ThreadId,
  type EnvironmentId,
  type NodeId,
  type OrchestrationV2DelegatedTaskFailure,
  type ScopedThreadRef,
} from "@cogenly/contracts";
import type { TimestampFormat } from "@cogenly/contracts/settings";
import {
  ArrowRightLeftIcon,
  ArrowRightIcon,
  BotIcon,
  ChevronRightIcon,
  GitForkIcon,
  MessageSquareIcon,
  MinusIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";

import {
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
  createTooltipHandle,
  type TooltipHandle,
} from "../ui/tooltip";
import { getProviderInstanceEntry } from "../../providerInstances";
import { formatShortTimestamp, formatUpcomingTimestamp } from "../../timestampFormat";
import { getTriggerDisplayModelName } from "./providerIconUtils";
import { ProviderInstanceIcon, providerTextColor } from "./ProviderInstanceIcon";
import { cn } from "~/lib/utils";
import { TimelineSystemDivider } from "./TimelineSystemDivider";
import { Button, InlineButton } from "../ui/button";
import { AppMark } from "../AppMark";

const LIFECYCLE_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "run_interrupt_request",
  "run_interrupt_result",
  "compaction",
  "handoff",
  "fork",
  "subagent",
  "thread_created",
]);

export function isV2LifecycleItem(item: OrchestrationV2TurnItem): boolean {
  return LIFECYCLE_TYPES.has(item.type);
}

export type { HandoffTimelineRun } from "@cogenly/client-runtime/handoff";

export function V2LifecycleRow(props: {
  readonly item: OrchestrationV2TurnItem;
  readonly environmentId: EnvironmentId;
  readonly resourceSummary?: boolean | undefined;
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly runs: ReadonlyArray<HandoffTimelineRun>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { item } = props;
  if (item.type === "run_interrupt_request") {
    return (
      <div className="flex justify-end px-1 py-1" data-v2-item-type={item.type}>
        <div className="flex max-w-[80%] items-center gap-2 text-xs text-destructive">
          <span aria-hidden="true" className="font-mono">
            ■
          </span>
          <span className="font-medium">Interrupt requested</span>
          <span aria-hidden="true" className="opacity-50">
            ·
          </span>
          <span className="font-medium">{item.message}</span>
          <span className="text-3xs text-muted-foreground">
            {formatShortTimestamp(props.createdAt, props.timestampFormat)}
          </span>
        </div>
      </div>
    );
  }
  if (item.type === "run_interrupt_result") {
    // A stop is the user's choice, so it reads calm; only a stop that failed is red.
    return item.status === "failed" ? (
      <TimelineSystemDivider label="Failed" detail={item.message} tone="danger" icon={XIcon} />
    ) : (
      <TimelineSystemDivider
        label="Stopped"
        icon={SquareIcon}
        iconClassName="size-2 fill-current"
        hint={`Stopped ${formatShortTimestamp(props.createdAt, props.timestampFormat)}`}
      />
    );
  }
  if (item.type === "compaction") {
    const tokenDetail =
      item.beforeTokenCount === undefined && item.afterTokenCount === undefined
        ? null
        : `${item.beforeTokenCount ?? "?"} → ${item.afterTokenCount ?? "?"} tokens`;
    const label =
      item.status === "failed"
        ? "Context compaction failed"
        : item.status === "cancelled" || item.status === "interrupted"
          ? "Context compaction stopped"
          : item.status === "pending" || item.status === "running" || item.status === "waiting"
            ? "Compacting context"
            : "Context compacted";
    return (
      <TimelineSystemDivider label={label} detail={item.summary ?? tokenDetail} icon={MinusIcon} />
    );
  }
  if (item.type === "handoff") {
    return (
      <HandoffRow
        endpoints={resolveHandoffEndpoints(item, props.runs)}
        providers={props.providerStatuses}
        failed={item.status === "failed"}
      />
    );
  }
  if (item.type === "fork") {
    const relatedThreadId = item.source.type === "run" ? item.source.threadId : item.targetThreadId;
    return (
      <TimelineSystemDivider
        label={item.source.type === "run" ? "Forked from conversation" : "Conversation fork"}
        icon={GitForkIcon}
        actionLabel={item.source.type === "run" ? "Open source conversation" : "Open fork"}
        onAction={() => props.onOpenThread(relatedThreadId)}
      />
    );
  }
  if (item.type === "thread_created") {
    if (props.resourceSummary) {
      return (
        <div
          data-v2-item-type={item.type}
          className="flex min-w-0 items-center gap-3 rounded-lg border border-border/60 p-3"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60">
            <MessageSquareIcon className="size-4 text-secondary-label" aria-hidden />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {item.title ?? "Created thread"}
          </span>
          <Button
            size="xs"
            variant="outline"
            aria-label={`Open ${item.title ?? "created thread"}`}
            onClick={() => props.onOpenThread(item.targetThreadId)}
          >
            Open chat
          </Button>
        </div>
      );
    }
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<AppMark className="size-4 text-icon-muted" aria-hidden />}
        label={<>Created thread{item.title ? ` · ${item.title}` : ""}</>}
        trailing={
          <InlineButton
            aria-label={`Open ${item.title ?? "created thread"}`}
            onClick={() => props.onOpenThread(item.targetThreadId)}
          >
            Open chat
          </InlineButton>
        }
      />
    );
  }
  if (item.type === "subagent") {
    return (
      <SubagentTimelineLink
        parentRef={scopeThreadRef(props.environmentId, item.threadId)}
        subagentId={item.subagentId}
        providerInstanceId={item.providerInstanceId}
        origin={item.origin}
        status={item.status}
        driver={item.driver}
        provider={props.providerStatuses.find(
          (provider) => provider.instanceId === item.providerInstanceId,
        )}
        providers={props.providerStatuses}
        title={formatSubagentDisplayTitle(item.title ?? "Subagent")}
        result={item.result}
        progress={item.progress}
        startedAt={item.startedAt}
        completedAt={item.completedAt}
        threadId={item.childThreadId}
        onOpenThread={props.onOpenThread}
      />
    );
  }
  return null;
}

function isoOrNull(value: DateTime.Utc | null | undefined): string | null {
  return value ? DateTime.formatIso(value) : null;
}

export function SubagentElapsed({ agent }: { agent: Parameters<typeof AgentElapsed>[0]["agent"] }) {
  return <AgentElapsed agent={agent} />;
}

/**
 * A subagent's avatar in the timeline: its provider mark on a small round tile,
 * with a status dot in the corner. Ported from T3 Code (MIT).
 */
function SubagentAvatar({
  driver,
  provider,
  status,
}: {
  driver?: ProviderDriverKind | undefined;
  provider?: ServerProvider | undefined;
  status: OrchestrationV2TurnItem["status"] | null;
}) {
  return (
    <span
      aria-hidden
      className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted ring-2 ring-background"
    >
      {driver ? (
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={provider?.displayName ?? driver}
          className="z-auto"
          iconClassName="size-3.5"
        />
      ) : (
        <BotIcon className="size-3.5 text-muted-foreground" />
      )}
      <BadgeDot
        tone={status ? subagentStatusVisual(status).tone : null}
        size="md"
        ring="background"
        className="absolute -right-px -bottom-px"
      />
    </span>
  );
}

/** The status a notification reported, frozen at the time it arrived. */
const NOTIFICATION_OUTCOME_STATUS: Record<
  OrchestrationV2Notification["outcome"],
  OrchestrationV2TurnItem["status"] | null
> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  updated: null,
  unknown: null,
};

const NOTIFICATION_OUTCOME_LABEL: Record<OrchestrationV2Notification["outcome"], string> = {
  completed: "Finished",
  failed: "Failed",
  cancelled: "Stopped",
  updated: "Updated",
  unknown: "Finished",
};

const DELEGATED_FAILURE_LABEL: Record<OrchestrationV2DelegatedTaskFailure["kind"], string> = {
  rate_limit: "rate limit",
  usage_limit: "usage limit",
  provider_error: "provider error",
  interrupted_by_restart: "interrupted by restart",
  crashed: "crashed",
};

/**
 * Why a delegated child stopped, with its limit reset in the user's own time,
 * or what the server did about a stop it is recovering on its own.
 */
function delegatedFailureLabel(
  failure: OrchestrationV2DelegatedTaskFailure,
  providers: ReadonlyArray<ServerProvider>,
  timestampFormat: TimestampFormat,
): string {
  const kind = DELEGATED_FAILURE_LABEL[failure.kind];
  const recovery = failure.recovery;
  switch (recovery?.type) {
    case "handed_off": {
      const provider = providers.find((entry) => entry.instanceId === recovery.providerInstanceId);
      return `Hit a ${kind}, handed off to ${provider?.displayName ?? recovery.providerInstanceId}`;
    }
    case "resuming_at_reset":
    case "retrying":
      return `Hit a ${kind}, resumes ${formatUpcomingTimestamp(recovery.at, timestampFormat)}`;
    case "resuming_after_restart":
      return "Resuming after restart";
    case undefined: {
      const reset = failure.resetAt
        ? formatUpcomingTimestamp(failure.resetAt, timestampFormat)
        : "";
      return `Stopped: ${kind}${reset ? `, resets ${reset}` : ""}`;
    }
  }
}

/** A notification about one subagent, drawn as that subagent's card. Renders `fallback` when the parent has no record of it. */
export function SubagentNotificationLink(props: {
  readonly parentRef: ScopedThreadRef;
  readonly childThreadId: ThreadId;
  readonly outcome: OrchestrationV2Notification["outcome"];
  /** Set when the notification reports this child's run failing or being cut off. */
  readonly failure?: OrchestrationV2DelegatedTaskFailure | undefined;
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly fallback: ReactNode;
}) {
  const agent = useAtomValue(environmentThreadDetails.threadAtom(props.parentRef), (thread) =>
    latestSubagentForChild(thread?.projection.subagents ?? [], props.childThreadId, (agent) =>
      DateTime.toEpochMillis(agent.startedAt ?? agent.updatedAt),
    ),
  );
  if (agent === null) return props.fallback;
  // A subagent resumed since this notification shows its live status, not the outcome reported then.
  const resumed =
    NOTIFICATION_OUTCOME_STATUS[props.outcome] !== null &&
    subagentResumedSince(
      { status: agent.status, startedAt: isoOrNull(agent.startedAt) },
      props.createdAt,
    );
  return (
    <SubagentTimelineLink
      parentRef={props.parentRef}
      subagentId={agent.id}
      providerInstanceId={agent.providerInstanceId}
      origin={agent.origin}
      status={agent.status}
      driver={agent.driver}
      provider={props.providerStatuses.find(
        (provider) => provider.instanceId === agent.providerInstanceId,
      )}
      providers={props.providerStatuses}
      title={formatSubagentDisplayTitle(agent.title ?? "Subagent")}
      result={agent.result}
      progress={agent.progress}
      startedAt={agent.startedAt}
      completedAt={agent.completedAt}
      threadId={props.childThreadId}
      onOpenThread={props.onOpenThread}
      {...(resumed
        ? {}
        : {
            event: {
              status: NOTIFICATION_OUTCOME_STATUS[props.outcome],
              label: props.failure
                ? delegatedFailureLabel(
                    props.failure,
                    props.providerStatuses,
                    props.timestampFormat,
                  )
                : NOTIFICATION_OUTCOME_LABEL[props.outcome],
              timestamp: formatShortTimestamp(props.createdAt, props.timestampFormat),
            },
          })}
    />
  );
}

/**
 * Provider-native children seen running in the background, per parent thread.
 * The roster drops a child once it ends, so it is remembered for the session.
 */
const backgroundChildrenByParent = new Map<string, Set<string>>();

const PENDING_OUTCOME_STATUS: Record<PendingCompletionOutcome, OrchestrationV2TurnItem["status"]> =
  {
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
  };

/**
 * Subagents that just finished, at the end of the parent's timeline, until the
 * parent's own notification for them lands: a busy parent only hears about a
 * background subagent on its next turn.
 */
export function PendingSubagentCompletions(props: {
  readonly parentRef: ScopedThreadRef;
  readonly timestampFormat: TimestampFormat;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const projection = useAtomValue(
    environmentThreadDetails.threadAtom(props.parentRef),
    (thread) => thread?.projection ?? null,
  );
  const parentKey = `${props.parentRef.environmentId}:${props.parentRef.threadId}`;
  const rows = useMemo(() => {
    if (projection === null) return [];
    const seen = backgroundChildrenByParent.get(parentKey) ?? new Set<string>();
    const rosterTaskIds = new Set<string>();
    for (const providerThread of projection.providerThreads) {
      for (const task of providerThread.pendingBackgroundTasks ?? []) {
        if (task.kind !== "subagent") continue;
        rosterTaskIds.add(task.taskId);
        const childThreadId = "childThreadId" in task ? task.childThreadId : undefined;
        if (typeof childThreadId === "string") seen.add(childThreadId);
      }
    }
    for (const subagent of projection.subagents) {
      const nativeId = subagent.nativeTaskRef?.nativeId ?? null;
      if (subagent.childThreadId !== null && nativeId !== null && rosterTaskIds.has(nativeId)) {
        seen.add(subagent.childThreadId);
      }
    }
    if (seen.size > 0) backgroundChildrenByParent.set(parentKey, seen);
    const notifiedAtMsByChild = new Map<string, number>();
    const noteNotified = (childThreadId: string | undefined, atMs: number) => {
      if (childThreadId === undefined) return;
      const previous = notifiedAtMsByChild.get(childThreadId);
      if (previous === undefined || atMs > previous) notifiedAtMsByChild.set(childThreadId, atMs);
    };
    for (const item of projection.turnItems) {
      if (item.type !== "notification") continue;
      noteNotified(
        notificationChildThreadId(item.source),
        DateTime.toEpochMillis(item.startedAt ?? item.updatedAt),
      );
    }
    for (const message of projection.messages) {
      if (message.notification === undefined) continue;
      noteNotified(
        notificationChildThreadId(message.notification.source),
        DateTime.toEpochMillis(message.createdAt),
      );
    }
    const pending = pendingSubagentCompletions({
      threadId: props.parentRef.threadId,
      subagents: projection.subagents.map((subagent) => ({
        id: subagent.id,
        threadId: subagent.threadId,
        origin: subagent.origin,
        childThreadId: subagent.childThreadId,
        status: subagent.status,
        completedAtMs:
          subagent.completedAt === null ? null : DateTime.toEpochMillis(subagent.completedAt),
        completionDelivery: subagent.completionDelivery,
      })),
      notifiedAtMsByChild,
      backgroundChildren: seen,
    });
    return pending.flatMap((completion) => {
      const agent = projection.subagents.find((subagent) => subagent.id === completion.subagentId);
      return agent === undefined ? [] : [{ completion, agent }];
    });
  }, [parentKey, projection, props.parentRef.threadId]);
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col" data-pending-subagent-completions="">
      {rows.map(({ completion, agent }) => (
        // Fades in where it lands; the notification that replaces it draws the same row.
        <div key={completion.childThreadId} className="swap-motion">
          <SubagentTimelineLink
            parentRef={props.parentRef}
            subagentId={agent.id}
            providerInstanceId={agent.providerInstanceId}
            origin={agent.origin}
            status={agent.status}
            driver={agent.driver}
            provider={props.providerStatuses.find(
              (provider) => provider.instanceId === agent.providerInstanceId,
            )}
            providers={props.providerStatuses}
            title={formatSubagentDisplayTitle(agent.title ?? "Subagent")}
            result={agent.result}
            progress={agent.progress}
            startedAt={agent.startedAt}
            completedAt={agent.completedAt}
            threadId={agent.childThreadId}
            onOpenThread={props.onOpenThread}
            event={{
              status: PENDING_OUTCOME_STATUS[completion.outcome],
              label: NOTIFICATION_OUTCOME_LABEL[completion.outcome],
              timestamp: formatShortTimestamp(
                new Date(completion.completedAtMs).toISOString(),
                props.timestampFormat,
              ),
            }}
          />
        </div>
      ))}
    </div>
  );
}

type SubagentHoverPayload = Parameters<typeof SubagentTimelineLink>[0];

const SubagentHoverHandle = createContext<TooltipHandle<SubagentHoverPayload> | null>(null);

/**
 * One hover card shared by the subagent rows inside it: moving between rows
 * glides the open card to the next row and cross-fades its content instead of
 * closing and re-popping it.
 */
export function SubagentHoverCardGroup({ children }: { children: ReactNode }) {
  const [handle] = useState(() => createTooltipHandle<SubagentHoverPayload>());
  return (
    <SubagentHoverHandle value={handle}>
      {children}
      <Tooltip handle={handle}>
        {({ payload }) =>
          payload ? (
            // Previews a timeline row, so the floating browser preview stays above it.
            <ThreadHoverCardPopup layer="content">
              <SubagentHoverContent {...payload} />
            </ThreadHoverCardPopup>
          ) : null
        }
      </Tooltip>
    </SubagentHoverHandle>
  );
}

function SubagentHoverContent(props: SubagentHoverPayload) {
  const agent = useAtomValue(
    environmentThreadDetails.threadAtom(props.parentRef),
    (thread) => thread?.projection.subagents.find((agent) => agent.id === props.subagentId) ?? null,
  );
  return (
    <SubagentTimelineTooltip
      {...props}
      elapsed={agent ? <AgentElapsed agent={projectedSubagentsToRuntime([agent])[0]!} /> : null}
      model={agent?.model ?? null}
      modelSelection={agent?.modelSelection}
      status={agent?.status ?? props.status}
      result={agent?.result ?? props.result}
      progress={agent?.progress ?? props.progress}
    />
  );
}

/**
 * A subagent's one row, whatever launched it (a native subagent, a
 * delegate-task call), after T3 Code: avatar with status dot, the title over a
 * one-line preview of its progress or result, and the elapsed time (or when a
 * notification arrived). The row opens the child thread; the hover card has
 * the rest.
 */
function SubagentTimelineLink(props: {
  readonly parentRef: ScopedThreadRef;
  readonly subagentId: NodeId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly driver: ProviderDriverKind;
  readonly provider: ServerProvider | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly title: string;
  readonly result: string | null;
  readonly progress: string | undefined;
  readonly status: OrchestrationV2TurnItem["status"];
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
  readonly threadId: ThreadId | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
  /** Draws a past event about the subagent: its status then, and when it happened instead of elapsed time. */
  readonly event?: {
    readonly status: OrchestrationV2TurnItem["status"] | null;
    readonly label: string;
    readonly timestamp: string;
  };
}) {
  const sharedHandle = use(SubagentHoverHandle);
  if (!sharedHandle) {
    return (
      <SubagentHoverCardGroup>
        <SubagentTimelineLink {...props} />
      </SubagentHoverCardGroup>
    );
  }
  return <SubagentRow {...props} hoverHandle={sharedHandle} />;
}

function SubagentRow({
  hoverHandle,
  ...props
}: SubagentHoverPayload & { readonly hoverHandle: TooltipHandle<SubagentHoverPayload> }) {
  const agent = useAtomValue(
    environmentThreadDetails.threadAtom(props.parentRef),
    (thread) => thread?.projection.subagents.find((agent) => agent.id === props.subagentId) ?? null,
  );
  const threadId = props.threadId;
  const liveStatus = agent?.status ?? props.status;
  const status = props.event ? props.event.status : liveStatus;
  const statusLabel = props.event?.label ?? subagentStatusVisual(liveStatus).label;
  const { detail, titleStatus } = subagentRowLines({
    status,
    liveStatus,
    statusLabel,
    result: agent?.result ?? props.result,
    progress: agent?.progress ?? props.progress,
    event: props.event !== undefined,
  });
  const failed = status === "failed";
  const timing = {
    status: liveStatus,
    startedAt: isoOrNull(agent?.startedAt ?? props.startedAt),
    completedAt: isoOrNull(agent?.completedAt ?? props.completedAt),
  };
  const className =
    "group/subagent flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left";
  return (
    <TooltipTrigger
      handle={hoverHandle}
      payload={props}
      delay={200}
      render={
        threadId === null ? (
          <div data-v2-item-type="subagent" aria-description={statusLabel} className={className} />
        ) : (
          <button
            type="button"
            data-v2-item-type="subagent"
            aria-label={`Open ${props.title}`}
            aria-description={statusLabel}
            onClick={() => props.onOpenThread(threadId)}
            className={cn(
              className,
              "cursor-pointer state-hover state-fade focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
            )}
          />
        )
      }
    >
      <SubagentAvatar driver={props.driver} provider={props.provider} status={status} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-xs font-medium text-foreground">
            {props.title}
          </span>
          {titleStatus !== null ? (
            <span
              key={titleStatus}
              className={cn(
                "shrink-0 text-3xs swap-motion",
                failed ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {titleStatus}
            </span>
          ) : null}
        </span>
        <span
          key={detail === null ? "status" : "detail"}
          className={cn(
            "block text-2xs leading-relaxed swap-motion",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {detail === null ? (
            statusLabel
          ) : detail.includes("/") && !detail.includes(" ") ? (
            <MiddleTruncate value={detail} showTitle={false} className="flex" />
          ) : (
            <span className="block truncate">{detail}</span>
          )}
        </span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {props.event ? props.event.timestamp : <SubagentElapsed agent={timing} />}
      </span>
      {threadId !== null ? (
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors duration-(--motion-duration-fast) ease-out group-hover/subagent:text-foreground"
        />
      ) : null}
    </TooltipTrigger>
  );
}

function SubagentTimelineTooltip(
  props: Parameters<typeof SubagentTimelineLink>[0] & {
    model: string | null;
    modelSelection: OrchestrationV2Subagent["modelSelection"];
    elapsed: ReactNode;
  },
) {
  const environmentId = props.parentRef.environmentId;
  const parent = useThreadShell(props.parentRef)?.source;
  const child = useThreadShell(
    props.threadId ? scopeThreadRef(environmentId, props.threadId) : null,
  )?.source;
  const parentProject = useProject(
    parent ? scopeProjectRef(environmentId, parent.projectId) : null,
  );
  const childProject = useProject(child ? scopeProjectRef(environmentId, child.projectId) : null);
  return (
    <SubagentTooltipContent
      title={formatSubagentDisplayTitle(child?.title ?? props.title)}
      model={props.model}
      providerInstanceId={props.providerInstanceId}
      origin={props.origin}
      modelSelection={props.modelSelection}
      provider={props.provider}
      providers={props.providers}
      driver={props.driver}
      elapsed={props.elapsed}
      status={props.status}
      result={props.result}
      progress={props.progress}
      parentThread={parent}
      childThread={child}
      parentProject={parentProject ?? undefined}
      childProject={childProject ?? undefined}
    />
  );
}

export function HandoffRow(props: {
  readonly endpoints: HandoffEndpoints;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly pending?: boolean;
  readonly failed?: boolean;
}) {
  const { from: fromEndpoints, to } = props.endpoints;
  return (
    <TimelineSystemDivider
      label={props.pending ? "Context handoff pending" : "Context handoff"}
      icon={ArrowRightLeftIcon}
      showDetailSeparator={false}
      tone={props.failed ? "danger" : "neutral"}
      detail={
        <span className="inline-flex min-w-0 flex-wrap items-center justify-center gap-1.5">
          {fromEndpoints.map((endpoint, index) => (
            <span
              key={`${endpoint.instanceId}:${endpoint.model ?? ""}`}
              className="inline-flex min-w-0 items-center"
            >
              <HandoffEndpoint
                providers={props.providers}
                instanceId={endpoint.instanceId}
                model={endpoint.model}
              />
              {index < fromEndpoints.length - 1 ? (
                <span aria-hidden="true" className="ml-0.5">
                  ,
                </span>
              ) : null}
            </span>
          ))}
          {fromEndpoints.length > 0 ? (
            <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0" />
          ) : null}
          <HandoffEndpoint
            providers={props.providers}
            instanceId={to.instanceId}
            model={to.model}
          />
        </span>
      }
    />
  );
}

function HandoffEndpoint(props: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId;
  readonly model?: string | undefined;
}) {
  const entry = getProviderInstanceEntry(props.providers, props.instanceId);
  const model = props.model?.trim();
  const providerModel =
    model === undefined || model.length === 0
      ? undefined
      : entry?.models.find((candidate) => candidate.slug === model);
  const label =
    providerModel !== undefined
      ? getTriggerDisplayModelName(providerModel)
      : model !== undefined && model.length > 0
        ? model
        : (entry?.displayName ?? props.instanceId);
  const labelColor = providerTextColor(
    entry?.driverKind ?? ProviderDriverKind.make(props.instanceId),
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className="inline-flex min-w-0 items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <ProviderInstanceIcon
              driverKind={entry?.driverKind ?? ProviderDriverKind.make(props.instanceId)}
              displayName={entry?.displayName ?? props.instanceId}
              accentColor={entry?.accentColor}
              showBadge={entry?.accentColor !== undefined}
              badgeClassName="size-1.5"
              iconClassName="size-3"
            />
            <span
              className={cn("truncate font-medium", labelColor.className)}
              style={labelColor.style}
            >
              {label}
            </span>
          </span>
        }
      />
      <TooltipPopup>
        {entry?.displayName ?? props.instanceId} · {label}
      </TooltipPopup>
    </Tooltip>
  );
}

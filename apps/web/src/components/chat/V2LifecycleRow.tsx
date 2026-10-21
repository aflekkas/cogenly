import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { AgentElapsed } from "./AgentElapsed";
import { projectedSubagentsToRuntime } from "@t3tools/client-runtime/state/subagentRuntime";
import { createContext, use, useState, type ReactNode } from "react";
import { useThreadShell, useProject } from "../../state/entities";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { environmentThreadDetails } from "../../state/threads";
import { MiddleTruncate } from "../ui/middle-truncate";
import * as DateTime from "effect/DateTime";
import { WorkLogChevron, WorkLogCollapse, WorkLogRow } from "./WorkLog";
import { markdownPreviewText } from "@t3tools/client-runtime/work-log/reasoning-text";
import ChatMarkdown from "../ChatMarkdown";
import { Spinner } from "../ui/spinner";
import {
  resolveHandoffEndpoints,
  type HandoffEndpoints,
  type HandoffTimelineRun,
} from "@t3tools/client-runtime/handoff";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
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
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  BotIcon,
  ArrowRightLeftIcon,
  ArrowRightIcon,
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
import { formatShortTimestamp } from "../../timestampFormat";
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

export type { HandoffTimelineRun } from "@t3tools/client-runtime/handoff";

export function V2LifecycleRow(props: {
  readonly item: OrchestrationV2TurnItem;
  readonly environmentId: EnvironmentId;
  readonly resourceSummary?: boolean | undefined;
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly runs: ReadonlyArray<HandoffTimelineRun>;
  readonly onOpenThread: (threadId: ThreadId) => void;
  /** Keeps a subagent row's open state across virtualized remounts and holds the scroll anchor. */
  readonly disclosure?: SubagentRowDisclosure | undefined;
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
        prompt={item.prompt}
        onOpenThread={props.onOpenThread}
        disclosure={props.disclosure}
      />
    );
  }
  return null;
}

/**
 * In-flight states all present as Working, the way the agents fleet view did:
 * detail belongs in the activity line, and a waiting or queued subagent is
 * still the fleet doing its job. Only settled states differentiate. Idle reads
 * as settled rather than in progress, since a resting child looks done unless
 * resumed.
 */
const STATUS_VISUALS: Record<
  OrchestrationV2TurnItem["status"],
  { dotClass: string; label: string }
> = {
  pending: { dotClass: "bg-info", label: "Queued" },
  running: { dotClass: "bg-info", label: "Running" },
  waiting: { dotClass: "bg-info", label: "Waiting" },
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle · resumable" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

function subagentStatusVisual(status: OrchestrationV2TurnItem["status"]) {
  return STATUS_VISUALS[status];
}

const SETTLED_SUBAGENT_STATUSES = new Set<OrchestrationV2TurnItem["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** The server's placeholder when a child ends without output; the status dot already says it. */
const GENERIC_CHILD_END = /^Child task ended with status\b/i;

function isoOrNull(value: DateTime.Utc | null | undefined): string | null {
  return value ? DateTime.formatIso(value) : null;
}

export function SubagentElapsed({ agent }: { agent: Parameters<typeof AgentElapsed>[0]["agent"] }) {
  return <AgentElapsed agent={agent} />;
}

/** Round provider tile with the agents panel's status dot; rings let a header stack overlap. */
export function SubagentAvatar({
  driver,
  provider,
  status,
  className,
}: {
  driver?: ProviderDriverKind | undefined;
  provider?: ServerProvider | undefined;
  /** Omitted inside an overlapped stack, where a covered dot would only add noise. */
  status?: OrchestrationV2TurnItem["status"] | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted ring-2 ring-background",
        className,
      )}
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
      {status ? (
        <span
          className={cn(
            "absolute -right-px -bottom-px size-2 rounded-full ring-2 ring-background",
            subagentStatusVisual(status).dotClass,
          )}
        />
      ) : null}
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

/** A notification about one subagent, drawn as that subagent's card. Renders `fallback` when the parent has no record of it. */
export function SubagentNotificationLink(props: {
  readonly parentRef: ScopedThreadRef;
  readonly childThreadId: ThreadId;
  readonly outcome: OrchestrationV2Notification["outcome"];
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly fallback: ReactNode;
}) {
  const agent = useAtomValue(
    environmentThreadDetails.threadAtom(props.parentRef),
    (thread) =>
      thread?.projection.subagents.find((agent) => agent.childThreadId === props.childThreadId) ??
      null,
  );
  if (agent === null) return props.fallback;
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
      event={{
        status: NOTIFICATION_OUTCOME_STATUS[props.outcome],
        label: NOTIFICATION_OUTCOME_LABEL[props.outcome],
        timestamp: formatShortTimestamp(props.createdAt, props.timestampFormat),
      }}
    />
  );
}

/** Where a subagent row keeps its open state, keyed by subagent id. */
export interface SubagentRowDisclosure {
  readonly isOpen: (subagentId: string) => boolean;
  /** Called before the row flips; `collapsed` is true when it closes. */
  readonly onToggle: (subagentId: string, collapsed: boolean) => void;
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
            <ThreadHoverCardPopup>
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

/** Running spins; settled states read as one word. Keyed by state, so a change fades in. */
function SubagentStatusLabel({
  status,
  label,
}: {
  status: OrchestrationV2TurnItem["status"] | null;
  label: string;
}) {
  const running = status === "pending" || status === "running" || status === "waiting";
  return (
    <span
      key={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-3xs swap-motion",
        status === "failed" ? "text-destructive" : running ? "text-info" : "text-muted-foreground",
      )}
    >
      {running ? <Spinner size="xs" aria-hidden /> : null}
      {status === "completed" && label === "Completed" ? "Done" : label}
    </span>
  );
}

/**
 * A subagent's one row, whatever launched it (a native subagent, a
 * delegate-task call): provider avatar, title, status, elapsed time and a
 * plain one-line preview of its result or progress. Expanding it shows the
 * task brief and the full result; Open goes to the child thread.
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
  readonly prompt?: string | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly disclosure?: SubagentRowDisclosure | undefined;
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
  const [localOpen, setLocalOpen] = useState(false);
  const [persistedOpen, setPersistedOpen] = useState(
    () => props.disclosure?.isOpen(props.subagentId) ?? false,
  );
  const open = props.disclosure ? persistedOpen : localOpen;
  const threadId = props.threadId;
  const liveStatus = agent?.status ?? props.status;
  const status = props.event ? props.event.status : liveStatus;
  const statusLabel = props.event?.label ?? subagentStatusVisual(liveStatus).label;
  const fullResult = (agent?.result ?? props.result)?.trim() ?? "";
  const result = GENERIC_CHILD_END.test(fullResult) ? "" : fullResult;
  const progress = (agent?.progress ?? props.progress)?.trim();
  const settled = SETTLED_SUBAGENT_STATUSES.has(status ?? liveStatus);
  const rawDetail = settled ? result || progress : progress || result;
  const detail = rawDetail ? markdownPreviewText(rawDetail) || null : null;
  const brief = props.prompt?.trim() ?? "";
  const expandable = brief !== "" || result !== "";
  const failed = status === "failed";
  const timing = {
    status: liveStatus,
    startedAt: isoOrNull(agent?.startedAt ?? props.startedAt),
    completedAt: isoOrNull(agent?.completedAt ?? props.completedAt),
  };
  const toggle = () => {
    if (!expandable) return;
    if (props.disclosure) {
      props.disclosure.onToggle(props.subagentId, open);
      setPersistedOpen(!open);
    } else {
      setLocalOpen(!open);
    }
  };
  const markdownThreadRef = threadId
    ? scopeThreadRef(props.parentRef.environmentId, threadId)
    : undefined;
  return (
    <div
      data-v2-item-type="subagent"
      className="group/timeline-row flex min-w-0 flex-col rounded-md"
    >
      <TooltipTrigger
        handle={hoverHandle}
        payload={props}
        delay={200}
        render={
          <div
            role={expandable ? "button" : undefined}
            tabIndex={expandable ? 0 : undefined}
            aria-expanded={expandable ? open : undefined}
            aria-label={props.title}
            aria-description={statusLabel}
            onClick={toggle}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggle();
              }
            }}
            className={cn(
              "flex w-full min-w-0 items-center gap-2.5 rounded-md px-1.5 py-1 text-left",
              expandable &&
                "cursor-pointer state-hover state-fade focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
            )}
          />
        }
      >
        <SubagentAvatar
          driver={props.driver}
          provider={props.provider}
          status={status ?? undefined}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-xs font-medium text-foreground">
              {props.title}
            </span>
            {expandable ? (
              <span className="flex size-4 shrink-0 items-center justify-center">
                <WorkLogChevron open={open} reveal />
              </span>
            ) : null}
            <SubagentStatusLabel status={status} label={statusLabel} />
          </span>
          {detail !== null ? (
            <span
              key={settled ? "result" : "progress"}
              className={cn(
                "block text-2xs leading-relaxed swap-motion",
                failed ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {detail.includes("/") && !detail.includes(" ") ? (
                <MiddleTruncate value={detail} showTitle={false} className="flex" />
              ) : (
                <span className="block truncate">{detail}</span>
              )}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {props.event ? props.event.timestamp : <SubagentElapsed agent={timing} />}
        </span>
        {threadId !== null ? (
          <InlineButton
            aria-label={`Open ${props.title}`}
            onClick={(event) => {
              event.stopPropagation();
              props.onOpenThread(threadId);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            Open
          </InlineButton>
        ) : null}
      </TooltipTrigger>
      <WorkLogCollapse open={open}>
        {/* Aligned under the title, past the avatar. */}
        <div className="ms-10 flex min-w-0 flex-col gap-2.5 pt-0.5 pb-2 text-xs select-text">
          {brief ? (
            <section className="flex min-w-0 flex-col gap-0.5" aria-label="Task">
              <h4 className="text-2xs font-medium text-muted-foreground">Task</h4>
              <p className="line-clamp-6 break-words whitespace-pre-wrap text-secondary-label">
                {brief}
              </p>
            </section>
          ) : null}
          {result ? (
            <section className="flex min-w-0 flex-col gap-0.5" aria-label="Result">
              <h4 className="text-2xs font-medium text-muted-foreground">Result</h4>
              <div
                className={cn(
                  "max-h-80 overflow-auto text-secondary-label",
                  failed && "text-destructive",
                )}
              >
                <ChatMarkdown
                  text={result}
                  cwd={undefined}
                  threadRef={markdownThreadRef}
                  headingLevelOffset={3}
                  lineBreaks
                />
              </div>
            </section>
          ) : null}
        </div>
      </WorkLogCollapse>
    </div>
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

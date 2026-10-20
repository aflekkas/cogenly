import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  NodeId,
  resolveEnvironmentMachineKind,
  ThreadId,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import {
  BotIcon,
  CopyIcon,
  CornerLeftUpIcon,
  FolderOpenIcon,
  GitForkIcon,
  ListTreeIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  SquareIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
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
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "../preview/fileExplorerLabel";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel } from "../ui/collapsible";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  deriveThreadAgents,
  formatThreadAgentsHeading,
  resolveThreadAgentsWindow,
  type ThreadAgentRow,
  type ThreadAgentStopTarget,
  type ThreadAgentSubagentInput,
  type ThreadAgentThreadInput,
} from "./threadAgents.logic";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./threadDetailsPanelStyles";

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

const ROW_ACTION_REVEAL_CLASS =
  "opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 group-focus-within:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100";

/**
 * The thread details popover behind the header's details button: where the
 * thread runs, where it came from, and every agent it spawned or handed work
 * to, with the actions to open or stop them.
 */
export function ThreadDetailsMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const [open, setOpen] = useState(false);
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

  const label =
    summary.running > 0 ? `Thread details, ${summary.running} running` : "Thread details";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label}
                  className="relative shrink-0 [-webkit-app-region:no-drag]"
                />
              }
            />
          }
        >
          <ListTreeIcon className="size-4" />
          {summary.running > 0 ? (
            <span
              aria-hidden
              className="swap-motion pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-info"
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="bottom" align="end" collisionPadding={8} width="md" padding="none">
        {shell ? (
          <ThreadDetailsMenuContent
            environmentId={props.environmentId}
            threadId={props.threadId}
            summary={summary}
            onNavigate={() => setOpen(false)}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

function ThreadDetailsMenuContent(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly summary: ReturnType<typeof deriveThreadAgents>;
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

  const machineLabel = serverConfig?.environment.label ?? "This machine";
  return (
    <div className="flex flex-col">
      <ThreadDetailsSection
        headingId="thread-details-environment-heading"
        title="Environment"
        separated={false}
      >
        <div className={cn("flex items-center", THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS)}>
          <EnvironmentMachineIcon
            kind={resolveEnvironmentMachineKind(serverConfig ?? null)}
            className={THREAD_DETAILS_PANEL_ICON_CLASS}
          />
          <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
            {machineLabel}
          </span>
        </div>
        {revealLabel !== null && workspacePath !== null ? (
          <Tooltip>
            <TooltipTrigger
              delay={300}
              render={<ThreadDetailsControl part="row" onClick={() => void reveal()} />}
            >
              <FolderOpenIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
                {revealLabel}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="left">{workspacePath}</TooltipPopup>
          </Tooltip>
        ) : null}
      </ThreadDetailsSection>
      {lineageLinks.length > 0 ? (
        <ThreadDetailsSection headingId="thread-details-lineage-heading" title="Lineage">
          {lineageLinks.map((link) => (
            <ThreadDetailsControl
              key={link.key}
              part="row"
              onClick={() => openThread(link.threadId)}
            >
              {link.icon}
              <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
                {link.prefix}
                {link.title ? (
                  <span className="font-normal text-muted-foreground"> · {link.title}</span>
                ) : null}
              </span>
            </ThreadDetailsControl>
          ))}
        </ThreadDetailsSection>
      ) : null}
      <ThreadAgentsSection
        environmentId={props.environmentId}
        summary={props.summary}
        onOpenThread={openThread}
      />
    </div>
  );
}

function ThreadAgentsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly summary: ReturnType<typeof deriveThreadAgents>;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [stoppingKey, setStoppingKey] = useState<string | null>(null);
  const providers = useServerConfigs().get(props.environmentId)?.providers;
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const stopWorkflow = useAtomCommand(orchestrationEnvironment.stopWorkflow, {
    reportFailure: false,
  });
  const { copyToClipboard } = useCopyToClipboard<{ link: string }>({
    onCopy: ({ link }) =>
      toastManager.add({ type: "success", title: "Thread link copied", description: link }),
    onError: () => toastManager.add({ type: "error", title: "Failed to copy thread link" }),
  });
  const { summary } = props;
  const { visible, hiddenCount } = resolveThreadAgentsWindow(summary.rows, showAll);

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

  const renderRow = (row: ThreadAgentRow, nested: boolean) => {
    const provider = providers?.find((entry) => entry.instanceId === row.providerInstanceId);
    const driver = (row.driver ?? provider?.driver ?? null) as ProviderDriverKind | null;
    const relativeAt = row.completedAt ?? row.sortAt;
    const content = (
      <>
        {driver ? (
          <ProviderInstanceIcon
            driverKind={driver}
            displayName={provider?.displayName ?? driver}
            iconClassName={THREAD_DETAILS_PANEL_ICON_CLASS}
          />
        ) : (
          <BotIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        )}
        <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
          {row.title}
        </span>
        <span
          key={row.status}
          className={cn(
            "swap-motion inline-flex shrink-0 items-center gap-1 text-2xs font-normal tabular-nums",
            row.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {row.status === "running" ? <Spinner size="xs" tone="muted" aria-hidden /> : null}
          {row.statusLabel}
          <AgentElapsed
            agent={{
              status: row.status === "running" ? "running" : "completed",
              startedAt: row.startedAt,
              completedAt: row.completedAt,
            }}
            compact
          />
          {row.status === "running" ? null : (
            <span className="text-muted-foreground/70">{formatRelativeTimeLabel(relativeAt)}</span>
          )}
        </span>
      </>
    );
    const { stop: stopTarget, threadId } = row;
    const canAct = stopTarget !== null || threadId !== null;
    return (
      <li key={row.key} className="m-0 list-none p-0">
        <div className="group flex items-center gap-0.5">
          {threadId !== null ? (
            <ThreadDetailsControl
              part="row"
              className="flex-1"
              onClick={() => props.onOpenThread(threadId)}
            >
              {content}
            </ThreadDetailsControl>
          ) : (
            <div className={cn("flex flex-1 items-center", THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS)}>
              {content}
            </div>
          )}
          {canAct ? (
            <span className={cn("flex shrink-0", ROW_ACTION_REVEAL_CLASS)}>
              <Menu>
                <MenuTrigger
                  render={
                    <ThreadDetailsControl part="icon" aria-label={`Actions for ${row.title}`} />
                  }
                >
                  <MoreHorizontalIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end">
                  {stopTarget !== null ? (
                    <MenuItem
                      disabled={stoppingKey !== null}
                      onClick={() => void stop(row, stopTarget)}
                    >
                      {stoppingKey === row.key ? (
                        <Spinner size="sm" aria-hidden />
                      ) : (
                        <SquareIcon className="fill-current" />
                      )}
                      Stop
                    </MenuItem>
                  ) : null}
                  {threadId !== null ? (
                    <MenuItem
                      onClick={() => {
                        const link = formatThreadLink(threadId, row.title);
                        copyToClipboard(link, { link });
                      }}
                    >
                      <CopyIcon />
                      Copy link
                    </MenuItem>
                  ) : null}
                </MenuPopup>
              </Menu>
            </span>
          ) : (
            <span aria-hidden className="size-6 shrink-0" />
          )}
        </div>
        {!nested && row.children.length > 0 ? (
          <ul className="m-0 list-none p-0 ps-4">
            {row.children.map((child) => renderRow(child, true))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-agents-heading"
      title="Agents"
      showHeading={false}
    >
      {summary.total === 0 ? (
        <>
          <div className="flex h-8 items-center px-2.5 text-xs font-medium text-muted-foreground">
            Agents
          </div>
          <p className="px-2.5 pb-1 text-sm text-muted-foreground/80">No agents yet</p>
        </>
      ) : (
        <>
          <CollapsibleSectionHeader
            variant="panel"
            expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            Agents ({summary.total})
            {summary.failed > 0 ? (
              <span className="text-destructive-foreground"> · {summary.failed} failed</span>
            ) : null}
          </CollapsibleSectionHeader>
          <Collapsible open={expanded}>
            <CollapsiblePanel>
              <ul aria-label={formatThreadAgentsHeading(summary)} className="m-0 list-none p-0">
                {visible.map((row) => renderRow(row, false))}
              </ul>
              {hiddenCount > 0 ? (
                <ThreadDetailsControl part="row" tone="muted" onClick={() => setShowAll(true)}>
                  Show all ({summary.rows.length})
                </ThreadDetailsControl>
              ) : null}
            </CollapsiblePanel>
          </Collapsible>
        </>
      )}
    </ThreadDetailsSection>
  );
}

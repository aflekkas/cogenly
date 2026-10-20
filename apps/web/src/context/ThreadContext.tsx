import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProjectLabelId,
  RunId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { ArrowUpRightIcon, LibraryIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Spinner } from "../components/ui/spinner";
import { Switch } from "../components/ui/switch";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useFactNavigation } from "../memory/useFacts";
import { agentWorkspaceRpc } from "../rpc/agents";
import { useThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  contextSourceThreadId,
  describeContextItem,
  groupContextItems,
  type ContextUsedItem,
} from "./contextUsed.logic";

const NO_LABELS: ReadonlyArray<ProjectLabelId> = [];

/** The thread's confirmed project tags; suggestions never count as context. */
export function useThreadConfirmedLabelIds(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ReadonlyArray<ProjectLabelId> {
  const tags = useEnvironmentQuery(
    environmentId === null || threadId === null
      ? null
      : serverEnvironment.threadProjectLabelsLive({ environmentId, input: { threadId } }),
  );
  const labels = tags.data?.labels;
  return useMemo(
    () =>
      labels ? labels.filter((tag) => tag.confirmedByUser).map((tag) => tag.labelId) : NO_LABELS,
    [labels],
  );
}

/**
 * The per-thread "Use project context" switch, for threads with confirmed projects.
 * Off keeps the thread's tags but stops retrieved context reaching the model.
 */
export function ProjectContextToggle(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const settings = useEnvironmentQuery(
    agentWorkspaceRpc.contextSettings({ environmentId, input: { threadId } }),
  );
  const canEdit = useAtomValue(agentWorkspaceRpc.contextSetEnabled.permissionAtom(environmentId));
  const setEnabled = useOrchestrationCommand(agentWorkspaceRpc.contextSetEnabled, {
    reportFailure: false,
  });
  const [pending, setPending] = useState<boolean | null>(null);
  const enabled = pending ?? settings.data?.enabled ?? null;
  const change = async (next: boolean) => {
    setPending(next);
    const result = await setEnabled({ environmentId, input: { threadId, enabled: next } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not change project context",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
    settings.refresh();
    setPending(null);
  };
  return (
    <div className="border-t border-border/70 px-3 py-2">
      <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
        <span className="min-w-0 flex-1">Use project context</span>
        <Switch
          size="sm"
          checked={enabled ?? false}
          disabled={enabled === null || pending !== null || !canEdit}
          onCheckedChange={(next) => void change(next)}
        />
      </label>
      <p className="mt-1 text-2xs text-muted-foreground">
        {settings.error
          ? settings.error
          : "Only confirmed facts, open items and Work from these projects are sent to the model."}
      </p>
    </div>
  );
}

/** Resolves the source thread's title from the client when the server sent none. */
function ContextUsedEntryRow(props: {
  readonly environmentId: EnvironmentId;
  readonly item: ContextUsedItem;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenExternal: (href: string) => void;
}) {
  const sourceThreadId = contextSourceThreadId(props.item);
  const shell = useThreadShell(
    sourceThreadId === null ? null : scopeThreadRef(props.environmentId, sourceThreadId),
  );
  const entry = describeContextItem(props.item, shell?.title ?? null);
  const time = formatRelativeTimeLabel(entry.at);
  return (
    <li className="flex flex-col gap-1 py-2.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
          {entry.title}
        </span>
        {time ? (
          <time dateTime={entry.at} className="shrink-0 text-muted-foreground text-xs tabular-nums">
            {time}
          </time>
        ) : null}
      </div>
      <p className="line-clamp-3 whitespace-pre-line text-muted-foreground text-sm">
        {entry.role ? (
          <span className="font-medium text-foreground">
            {entry.role === "user" ? "You" : "Assistant"}:{" "}
          </span>
        ) : null}
        {entry.snippet}
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
        <span className="min-w-0 truncate">{entry.reason}</span>
        {sourceThreadId !== null ? (
          <Button size="xs" variant="link" onClick={() => props.onOpenThread(sourceThreadId)}>
            Open thread
            <ArrowUpRightIcon />
          </Button>
        ) : null}
        {entry.external.map((link) => (
          <Button
            key={link.href}
            size="xs"
            variant="link"
            onClick={() => props.onOpenExternal(link.href)}
          >
            {link.label}
            <ArrowUpRightIcon />
          </Button>
        ))}
      </div>
    </li>
  );
}

function ContextUsedBody(props: {
  readonly environmentId: EnvironmentId;
  readonly items: ReadonlyArray<ContextUsedItem>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenExternal: (href: string) => void;
}) {
  if (props.items.length === 0) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          {props.loading ? <Spinner /> : null}
          <EmptyTitle>
            {props.loading
              ? "Loading context"
              : props.error
                ? "Could not load context"
                : "No context added"}
          </EmptyTitle>
          <EmptyDescription>
            {props.loading
              ? "Fetching what this reply was given."
              : (props.error ?? "Cogenly added nothing from your projects to this reply.")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return groupContextItems(props.items).map((group) => (
    <section key={group.kind} aria-label={group.label}>
      <h3 className="font-medium text-muted-foreground text-xs">
        {group.label} <span className="tabular-nums">{group.items.length}</span>
      </h3>
      <ul className="divide-y divide-border/70">
        {group.items.map((item) => (
          <ContextUsedEntryRow
            key={`${item.kind}:${item.id}`}
            environmentId={props.environmentId}
            item={item}
            onOpenThread={props.onOpenThread}
            onOpenExternal={props.onOpenExternal}
          />
        ))}
      </ul>
    </section>
  ));
}

/**
 * The "Context used" icon for one finished turn, in the reply's action row: what
 * retrieval added to the prompt, opened in a dialog with links to each source. Only
 * threads that can receive context ask, and it renders nothing until the run is known
 * to have used some.
 */
export function ContextUsedButton(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly runId: RunId | null;
}) {
  const environmentId = props.threadRef?.environmentId ?? null;
  const threadId = props.threadRef?.threadId ?? null;
  const confirmed = useThreadConfirmedLabelIds(environmentId, threadId);
  const shell = useThreadShell(props.threadRef);
  const eligible = confirmed.length > 0 || shell?.source.agent !== undefined;
  const used = useEnvironmentQuery(
    eligible && environmentId !== null && props.runId !== null
      ? agentWorkspaceRpc.contextForRun({ environmentId, input: { runId: props.runId } })
      : null,
  );
  const navigation = useFactNavigation(environmentId);
  const [open, setOpen] = useState(false);
  const items: ReadonlyArray<ContextUsedItem> = used.data?.items ?? [];
  const count = items.length;
  if ((count === 0 && !open) || environmentId === null) return null;
  const label = `Context used · ${count} ${count === 1 ? "item" : "items"}`;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-label={label}
              aria-haspopup="dialog"
              onClick={() => setOpen(true)}
            />
          }
        >
          <LibraryIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Context used</DialogTitle>
            <DialogDescription>What Cogenly added to the prompt for this reply</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ContextUsedBody
              environmentId={environmentId}
              items={items}
              loading={used.isPending && used.data === null}
              error={used.error}
              onOpenThread={(target) => {
                setOpen(false);
                navigation.onOpenThread(target);
              }}
              onOpenExternal={navigation.onOpenExternal}
            />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

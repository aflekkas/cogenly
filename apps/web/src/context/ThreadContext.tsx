import { OverlayPresence } from "~/components/ui/overlay-presence";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ContextItem,
  EnvironmentId,
  MessageId,
  ProjectLabelId,
  RunId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { ArrowUpRightIcon, BookmarkPlusIcon, ChevronDownIcon, LibraryIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { factSubjectFrom, rememberMessageInput, resolveFactRefs } from "../memory/facts.logic";
import { FactEditorDialog, factInputFromDraft } from "../memory/FactList";
import { useFactActions, useFactNavigation } from "../memory/useFacts";
import { useEnvironmentProjectLabels } from "../projectLabels/useProjectLabels";
import { agentWorkspaceRpc } from "../rpc/agents";
import { useThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

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

const CONTEXT_KIND_LABEL: Record<ContextItem["kind"], string> = {
  fact: "Fact",
  commitment: "Open item",
  message: "Message",
  work: "Work outcome",
};

function ContextUsedPanel(props: {
  environmentId: EnvironmentId;
  items: ReadonlyArray<ContextItem>;
  onOpenThread: (threadId: ThreadId) => void;
  onOpenExternal: (href: string) => void;
}) {
  return (
    <ul className="reveal-motion mt-1.5 flex max-w-prose flex-col gap-1.5 border-s border-border/70 ps-3 text-xs text-muted-foreground">
      {props.items.map((item) => {
        const links = resolveFactRefs(item.refs).filter((ref) => ref.kind !== "text");
        return (
          <li key={`${item.kind}:${item.id}`} className="flex flex-col">
            <span className="line-clamp-2">
              <span className="text-foreground">{CONTEXT_KIND_LABEL[item.kind]}</span> · {item.text}
            </span>
            {links.length > 0 ? (
              <span className="flex flex-wrap items-center gap-1">
                {links.map((ref, index) => (
                  <Button
                    // oxlint-disable-next-line react/no-array-index-key -- refs are a stable snapshot
                    key={index}
                    size="xs"
                    variant="link"
                    onClick={() =>
                      ref.kind === "thread"
                        ? props.onOpenThread(ref.threadId)
                        : ref.kind === "external"
                          ? props.onOpenExternal(ref.href)
                          : undefined
                    }
                  >
                    {ref.label}
                    {ref.kind === "external" ? <ArrowUpRightIcon /> : null}
                  </Button>
                ))}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "Context used (N)" for one finished turn: what retrieval added to the prompt, with
 * links to where each item came from. Only threads that can receive context ask, and
 * the trigger renders nothing until the run is known to have used some.
 */
export function ContextUsed(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly runId: RunId | null;
  readonly children: (parts: { trigger: ReactNode; panel: ReactNode }) => ReactNode;
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
  const items = used.data?.items ?? [];
  const count = items.length;
  const trigger =
    count > 0 ? (
      <Button
        type="button"
        size="xs"
        variant="ghost-muted"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <LibraryIcon />
        Context used ({count})
        <ChevronDownIcon className={open ? "rotate-180" : undefined} />
      </Button>
    ) : null;
  const panel =
    open && count > 0 && environmentId !== null ? (
      <ContextUsedPanel environmentId={environmentId} items={items} {...navigation} />
    ) : null;
  return props.children({ trigger, panel });
}

/**
 * Saves a chat message as a confirmed fact citing it. The editor opens prefilled so the
 * wording and projects can be adjusted; projects default to the thread's confirmed tags.
 */
export function RememberMessageButton(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly messageId: MessageId;
  readonly text: string;
}) {
  const environmentId = props.threadRef?.environmentId ?? null;
  const threadId = props.threadRef?.threadId ?? null;
  const confirmed = useThreadConfirmedLabelIds(environmentId, threadId);
  const { labels } = useEnvironmentProjectLabels(environmentId);
  const actions = useFactActions(environmentId);
  const [editing, setEditing] = useState(false);
  if (threadId === null || !props.text.trim()) return null;
  const input = rememberMessageInput({
    text: props.text,
    threadId,
    messageId: props.messageId,
    labelIds: confirmed,
  });
  if (!input) return null;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              aria-label="Remember this"
              disabled={!actions.canWrite}
              onClick={() => setEditing(true)}
            />
          }
        >
          <BookmarkPlusIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>
          {actions.canWrite ? "Remember this" : "This connection cannot change memory."}
        </TooltipPopup>
      </Tooltip>
      <OverlayPresence when={editing}>
        {() => (
          <FactEditorDialog
            title="Remember this"
            description="Saved as a confirmed fact that links back to this message. Manage it in Settings → Memory."
            labels={labels}
            initial={{
              subject: factSubjectFrom(input.text),
              text: input.text,
              labelIds: confirmed,
            }}
            saveLabel="Remember"
            onClose={() => setEditing(false)}
            onSave={async (draft) => {
              const saved = await actions.create(
                factInputFromDraft(draft, { sourceRefs: input.sourceRefs }),
              );
              if (saved) {
                setEditing(false);
                toastManager.add({ type: "success", title: "Remembered" });
              }
            }}
          />
        )}
      </OverlayPresence>
    </>
  );
}

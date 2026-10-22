import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  WorkHandoffError,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type WorkTask,
} from "@t3tools/contracts";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleSlashIcon,
  ExternalLinkIcon,
  WrenchIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { useId, useMemo, useRef, useState } from "react";

import { useScratchProject } from "~/hooks/useScratchProject";
import { cn, randomUUID } from "~/lib/utils";
import { useProjects, useServerConfigs, useThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { WorkLogCollapse, WorkLogShimmer } from "../chat/WorkLog";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { useWorkPickerChoices } from "./StartWork";
import { ADD_REPOSITORY, describeWorkStartFailure, NO_REPOSITORY } from "./work.logic";
import {
  deriveWorkTaskCardState,
  WORK_TASK_STATE_LABEL,
  workTaskCanStop,
  type WorkTaskCardState,
} from "./workTask.logic";

const isWorkHandoffError = Schema.is(WorkHandoffError);

/** Same budget as the server's card brief. */
const BRIEF_MAX = 4000;

/**
 * True once `value` differs from what it was at mount, so a card animates the
 * state change the user just caused or watched, never history on load.
 */
function useChangedSinceMount<T>(value: T): boolean {
  const [initial] = useState(value);
  const [changed, setChanged] = useState(false);
  const differs = !Object.is(initial, value);
  if (differs && !changed) setChanged(true);
  return changed || differs;
}

/** Fades content in when it changes after mount: opacity only, so reduced motion keeps it too. */
const changeFade =
  "transition-opacity duration-(--motion-duration-fast) ease-out starting:opacity-0";

function StateIcon({ state }: { readonly state: WorkTaskCardState }) {
  switch (state) {
    case "starting":
    case "running":
      return <Spinner size="xs" tone="muted" aria-hidden />;
    case "attention":
    case "failed":
      return <CircleAlertIcon aria-hidden className="size-3 shrink-0 text-warning" />;
    case "done":
      return <CheckIcon aria-hidden className="size-3 shrink-0 text-success" />;
    case "stopped":
      return <CircleSlashIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />;
    case "proposed":
    case "dismissed":
      return null;
  }
}

/**
 * A task the chat's agent handed off, inline in the chat: proposed (Approve,
 * Edit, Dismiss), then the Work thread's live state with its result once it
 * reports back. The Work thread itself opens from the card.
 */
export function WorkTaskCard(props: {
  readonly environmentId: EnvironmentId;
  readonly chatThreadId: ThreadId;
  readonly task: WorkTask;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { environmentId, chatThreadId, task } = props;
  const workRef = useMemo(
    () => (task.threadId === undefined ? null : scopeThreadRef(environmentId, task.threadId)),
    [environmentId, task.threadId],
  );
  const workThread = useThreadShell(workRef);
  const state = deriveWorkTaskCardState(task, workThread ?? null);
  const stateChanged = useChangedSinceMount(state);
  const projects = useProjects();
  const scratchWorkspaceRoot = useServerConfigs().get(environmentId)?.scratchWorkspaceRoot;
  const target = projects.find(
    (project) => project.environmentId === environmentId && project.id === task.targetProjectId,
  );
  const repository =
    target === undefined ||
    target.isScratch === true ||
    isScratchProject(target, scratchWorkspaceRoot)
      ? null
      : target;
  const targetIsScratch = repository === null;
  const startWork = useAtomCommand(serverEnvironment.startWork, { reportFailure: false });
  const dismissTask = useAtomCommand(threadEnvironment.dismissWorkTask, { reportFailure: false });
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const { openScratchProject } = useScratchProject();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  // One approval is one command, so a retry after a lost response repairs instead of duplicating.
  const approveCommandId = useRef<CommandId | null>(null);

  const approve = async (edits?: {
    readonly choice: ProjectId | typeof NO_REPOSITORY;
    readonly title: string;
    readonly brief: string;
    readonly workspace: "worktree" | "local" | undefined;
  }) => {
    if (busy) return;
    setBusy(true);
    try {
      const targetProjectId =
        edits === undefined
          ? task.targetProjectId
          : edits.choice === NO_REPOSITORY
            ? (await openScratchProject(environmentId))?.id
            : edits.choice;
      if (targetProjectId === undefined) return;
      approveCommandId.current ??= CommandId.make(randomUUID());
      const result = await startWork({
        environmentId,
        input: {
          commandId: approveCommandId.current,
          sourceThreadId: chatThreadId,
          targetProjectId,
          taskId: task.id,
          ...(edits === undefined
            ? {}
            : {
                title: edits.title.trim() || task.title,
                scopeSummary: edits.brief.trim() || task.brief,
                ...(edits.workspace === undefined ? {} : { workspace: edits.workspace }),
              }),
        },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const failure = squashAtomCommandFailure(result);
        const described = describeWorkStartFailure(
          isWorkHandoffError(failure) ? failure.stage : null,
        );
        if (!described.retryWithSameCommand) approveCommandId.current = null;
        toastManager.add({
          type: "error",
          title: "Could not start the task",
          description: described.message,
        });
        return;
      }
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const setDismissed = async (dismissed: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await dismissTask({
        environmentId,
        input: { threadId: chatThreadId, taskId: task.id, dismissed },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: dismissed ? "Could not dismiss the task" : "Could not restore the task",
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (task.threadId === undefined || busy) return;
    setBusy(true);
    try {
      const result = await interruptTurn({
        environmentId,
        input: { threadId: task.threadId },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add({ type: "error", title: "Could not stop the task" });
      }
    } finally {
      setBusy(false);
    }
  };

  const targetLabel = repository === null ? "No project · this machine" : repository.title;
  const label = WORK_TASK_STATE_LABEL[state];

  if (state === "dismissed") {
    return (
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-lg border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground",
          stateChanged && changeFade,
        )}
      >
        <WrenchIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="shrink-0">Task dismissed</span>
        <span className="min-w-0 flex-1 truncate">{task.title}</span>
        <Button
          size="compact"
          variant="ghost-muted"
          disabled={busy}
          onClick={() => void setDismissed(false)}
        >
          Restore
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border border-border bg-background text-xs",
        stateChanged && changeFade,
      )}
      aria-label={`Task: ${task.title}, ${label}`}
      role="group"
    >
      <div className="flex min-w-0 items-center gap-2 px-3 pt-2.5">
        <WrenchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">
          {task.requestedMode === "start" || task.status === "started" ? "Task" : "Proposed task"}
        </span>
        <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />
        {/* Keyed so a state change fades the new label in instead of swapping it. */}
        <span
          key={state}
          aria-live="polite"
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-secondary-label",
            stateChanged && changeFade,
          )}
        >
          <StateIcon state={state} />
          <WorkLogShimmer active={state === "running"}>{label}</WorkLogShimmer>
        </span>
        <span className="min-w-0 flex-1" />
        {task.threadId === undefined ? null : (
          <Button
            size="compact"
            variant="ghost-muted"
            onClick={() => props.onOpenThread(task.threadId!)}
          >
            Open task
            <ExternalLinkIcon aria-hidden />
          </Button>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 px-3 pt-1.5 pb-3">
        <p className="min-w-0 text-sm font-medium text-foreground">{task.title}</p>
        <p className="line-clamp-3 min-w-0 whitespace-pre-wrap break-words text-secondary-label">
          {task.brief}
        </p>
        <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          {repository === null ? null : (
            <ProjectFavicon project={repository} className="size-3.5 shrink-0" />
          )}
          <span className="min-w-0 truncate">{targetLabel}</span>
          {task.modelSelection === undefined ? null : (
            <>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate">{task.modelSelection.model}</span>
            </>
          )}
        </div>
        {task.outcome?.summary && (state === "done" || state === "failed") ? (
          <p
            className={cn(
              "min-w-0 break-words",
              state === "failed" ? "text-warning-foreground" : "text-secondary-label",
              stateChanged && changeFade,
            )}
          >
            {task.outcome.summary}
          </p>
        ) : null}
        {state === "proposed" && !editing ? (
          <div className="flex items-center gap-1.5 pt-1">
            <Button size="compact" variant="pixel" disabled={busy} onClick={() => void approve()}>
              Approve
            </Button>
            <Button
              size="compact"
              variant="outline"
              disabled={busy}
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
            <Button
              size="compact"
              variant="ghost-muted"
              disabled={busy}
              onClick={() => void setDismissed(true)}
            >
              Dismiss
            </Button>
          </div>
        ) : null}
        {workTaskCanStop(state) && task.threadId !== undefined ? (
          <div className="flex items-center gap-1.5 pt-1">
            <Button
              size="compact"
              variant="ghost-destructive"
              disabled={busy}
              onClick={() => void stop()}
            >
              Stop
            </Button>
          </div>
        ) : null}
      </div>
      <WorkLogCollapse open={state === "proposed" && editing}>
        <WorkTaskEditor
          environmentId={environmentId}
          chatThreadId={chatThreadId}
          task={task}
          targetIsScratch={targetIsScratch}
          busy={busy}
          onCancel={() => setEditing(false)}
          onApprove={(edits) => void approve(edits)}
        />
      </WorkLogCollapse>
    </div>
  );
}

/** Approve with edits: where the task runs, how it checks out, and what it is told. */
function WorkTaskEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly chatThreadId: ThreadId;
  readonly task: WorkTask;
  readonly targetIsScratch: boolean;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onApprove: (edits: {
    readonly choice: ProjectId | typeof NO_REPOSITORY;
    readonly title: string;
    readonly brief: string;
    readonly workspace: "worktree" | "local" | undefined;
  }) => void;
}) {
  const { task } = props;
  const chatRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.chatThreadId),
    [props.chatThreadId, props.environmentId],
  );
  const choices = useWorkPickerChoices(chatRef).filter((choice) => choice.value !== ADD_REPOSITORY);
  const [choice, setChoice] = useState<ProjectId | typeof NO_REPOSITORY>(
    props.targetIsScratch ? NO_REPOSITORY : task.targetProjectId,
  );
  const [title, setTitle] = useState<string>(task.title);
  const [brief, setBrief] = useState<string>(task.brief);
  const [workspace, setWorkspace] = useState<"worktree" | "local" | "default">(
    task.workspace ?? "default",
  );
  const fieldId = useId();
  const selected = choices.find((candidate) => candidate.value === choice);
  return (
    <div className="flex min-w-0 flex-col gap-2 border-t border-border px-3 pt-2.5 pb-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Select<ProjectId | typeof NO_REPOSITORY>
          value={choice}
          onValueChange={(value) => {
            if (value !== null) setChoice(value);
          }}
        >
          <SelectTrigger size="xs" className="w-48" aria-label="Where the task runs">
            <SelectValue>{selected?.label ?? "No project"}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {choices.map((candidate) => (
              <SelectItem key={candidate.value} value={candidate.value}>
                {candidate.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {choice === NO_REPOSITORY ? null : (
          <Select<"worktree" | "local" | "default">
            value={workspace}
            onValueChange={(value) => {
              if (value !== null) setWorkspace(value);
            }}
          >
            <SelectTrigger size="xs" className="w-40" aria-label="Checkout">
              <SelectValue>
                {workspace === "worktree"
                  ? "New worktree"
                  : workspace === "local"
                    ? "Local checkout"
                    : "Default checkout"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              <SelectItem value="default">Default checkout</SelectItem>
              <SelectItem value="worktree">New worktree</SelectItem>
              <SelectItem value="local">Local checkout</SelectItem>
            </SelectPopup>
          </Select>
        )}
      </div>
      <label className="sr-only" htmlFor={`${fieldId}-title`}>
        Task title
      </label>
      <Input
        id={`${fieldId}-title`}
        size="sm"
        value={title}
        maxLength={200}
        onChange={(event) => setTitle(event.target.value)}
      />
      <label className="sr-only" htmlFor={`${fieldId}-brief`}>
        Task instructions
      </label>
      <Textarea
        id={`${fieldId}-brief`}
        size="sm"
        value={brief}
        maxLength={BRIEF_MAX}
        onChange={(event) => setBrief(event.target.value)}
      />
      <div className="flex items-center gap-1.5">
        <Button
          size="compact"
          variant="pixel"
          disabled={props.busy || brief.trim().length === 0}
          onClick={() =>
            props.onApprove({
              choice,
              title,
              brief,
              workspace: workspace === "default" ? undefined : workspace,
            })
          }
        >
          Approve
        </Button>
        <Button size="compact" variant="ghost-muted" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

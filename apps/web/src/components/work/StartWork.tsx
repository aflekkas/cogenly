import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type MessageId,
  type ScopedThreadRef,
  WorkHandoffError,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FolderGit2Icon, FolderPlusIcon, MessageSquareDashedIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { type ReactElement, type ReactNode, useCallback, useMemo, useState } from "react";
import { create } from "zustand";

import { openCommandPalette } from "~/commandPaletteBus";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useThreadKind } from "~/hooks/useThreadKind";
import { randomUUID } from "~/lib/utils";
import {
  useProjects,
  useServerConfigs,
  useThreadShell,
  waitForThreadShell,
} from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { threadCapabilities } from "~/threadCapabilities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useUiStateStore } from "~/uiStateStore";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxItemIcon,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { ProjectFavicon } from "../ProjectFavicon";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ADD_REPOSITORY,
  describeWorkStartFailure,
  listWorkPickerChoices,
  listWorkRepositories,
  NO_REPOSITORY,
  openWorkWhenArrived,
  type WorkPickerChoice,
  type WorkRepositoryChoice,
} from "./work.logic";

const isWorkHandoffError = Schema.is(WorkHandoffError);

/** Chats with a Work start in flight, so every entry point shows it and none starts twice. */
const usePendingStarts = create<{ readonly pending: ReadonlySet<string> }>(() => ({
  pending: new Set(),
}));

function setPending(key: string, pending: boolean) {
  usePendingStarts.setState((state) => {
    const next = new Set(state.pending);
    if (pending) next.add(key);
    else next.delete(key);
    return { pending: next };
  });
}

/** Whether this chat is starting Work right now. */
export function useStartWorkPending(threadRef: ScopedThreadRef | null): boolean {
  const key = threadRef === null ? null : scopedThreadKey(threadRef);
  return usePendingStarts((state) => key !== null && state.pending.has(key));
}

/**
 * Command ids kept for a start that may have half-landed: retrying the same
 * pick then repairs that Work thread instead of starting a second one.
 */
const retryCommandIds = new Map<string, CommandId>();

export interface StartWorkRequest {
  readonly threadRef: ScopedThreadRef;
  readonly choice: WorkRepositoryChoice;
  /** The last chat message the Work carries over; absent means the whole chat. */
  readonly throughMessageId?: MessageId;
  /** Shows the start in a toast, for entry points that close before it lands. */
  readonly announce?: boolean;
}

/**
 * Starts Work from a chat at once and opens it. The server titles the thread,
 * carries the chat's own words over, picks a worktree where there is git, and
 * keeps the chat's model. Failures land in a toast.
 */
export function useStartWork(): (request: StartWorkRequest) => Promise<void> {
  const navigate = useNavigate();
  const startWork = useAtomCommand(serverEnvironment.startWork, { reportFailure: false });
  const { openScratchProject } = useScratchProject();
  return useCallback(
    async ({ threadRef, choice, throughMessageId, announce = false }) => {
      const key = scopedThreadKey(threadRef);
      if (usePendingStarts.getState().pending.has(key)) return;
      setPending(key, true);
      const progressToast = announce
        ? toastManager.add({ type: "loading", title: "Starting Work…", timeout: 0 })
        : null;
      try {
        const { environmentId } = threadRef;
        // "No repository" is the environment's scratch project, created on first use.
        const targetProjectId =
          choice === NO_REPOSITORY ? (await openScratchProject(environmentId))?.id : choice;
        if (targetProjectId === undefined) return;
        const attemptKey = `${key}|${throughMessageId ?? ""}|${targetProjectId}`;
        const commandId = retryCommandIds.get(attemptKey) ?? CommandId.make(randomUUID());
        retryCommandIds.set(attemptKey, commandId);
        const result = await startWork({
          environmentId,
          input: {
            commandId,
            sourceThreadId: threadRef.threadId,
            targetProjectId,
            ...(throughMessageId === undefined ? {} : { throughMessageId }),
          },
        });
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          const failure = squashAtomCommandFailure(result);
          const described = describeWorkStartFailure(
            isWorkHandoffError(failure) ? failure.stage : null,
          );
          if (!described.retryWithSameCommand) retryCommandIds.delete(attemptKey);
          toastManager.add({
            type: "error",
            title: "Could not start Work",
            description: described.message,
          });
          return;
        }
        retryCommandIds.delete(attemptKey);
        // The Work thread lists in Work; switch now rather than when its shell arrives.
        useUiStateStore.getState().setSidebarMode("tasks");
        const workThreadRef = scopeThreadRef(environmentId, result.value.threadId);
        const opened = await openWorkWhenArrived({
          waitForThread: () => waitForThreadShell(workThreadRef),
          open: () =>
            navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(workThreadRef),
            }),
        });
        if (!opened) {
          toastManager.add({
            type: "warning",
            title: "Work started",
            description: "It has not reached this window yet. Open it from Work.",
          });
        }
      } finally {
        if (progressToast !== null) toastManager.close(progressToast);
        setPending(key, false);
      }
    },
    [navigate, openScratchProject, startWork],
  );
}

/** Whether a thread can start Work: only a chat hands off, on a connection allowed to. */
export function useCanStartWork(threadRef: ScopedThreadRef | null): boolean {
  const thread = useThreadShell(threadRef);
  const kind = useThreadKind(thread);
  const allowed = useAtomValue(
    serverEnvironment.startWork.permissionAtom(threadRef?.environmentId ?? null),
  );
  return threadRef !== null && kind !== null && allowed && threadCapabilities(kind).startWork;
}

/**
 * Where a chat can start Work, in picker order: the chat's own repository
 * first, then every other one, "No repository" where the machine offers it,
 * and "Add repository" last. Shared by the anchored picker and the palette.
 */
export function useWorkPickerChoices(threadRef: ScopedThreadRef): ReadonlyArray<WorkPickerChoice> {
  const thread = useThreadShell(threadRef);
  const projects = useProjects();
  const scratchWorkspaceRoot = useServerConfigs().get(
    threadRef.environmentId,
  )?.scratchWorkspaceRoot;
  return useMemo(
    () =>
      listWorkPickerChoices({
        repositories: listWorkRepositories(projects, threadRef.environmentId, scratchWorkspaceRoot),
        sourceProjectId: thread?.projectId ?? null,
        canRunWithoutRepository: scratchWorkspaceRoot != null,
      }),
    [projects, scratchWorkspaceRoot, thread?.projectId, threadRef.environmentId],
  );
}

/**
 * The composer's repository picker, anchored under `trigger`: type to filter
 * every repository, arrows and Enter to pick, and the pick starts Work.
 */
export function StartWorkPicker(props: {
  readonly threadRef: ScopedThreadRef;
  readonly throughMessageId?: MessageId;
  /** The button that opens the picker. */
  readonly trigger: ReactElement;
  readonly tooltip: string;
  /** The trigger's content, given whether this chat is starting Work right now. */
  readonly children: (pending: boolean) => ReactNode;
}) {
  const { threadRef, throughMessageId } = props;
  const choices = useWorkPickerChoices(threadRef);
  const startWork = useStartWork();
  const pending = useStartWorkPending(threadRef);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filter = useComboboxFilter();
  const filtered = useMemo(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return choices;
    return choices.filter(
      (choice) =>
        choice.value !== ADD_REPOSITORY &&
        filter.contains(choice, trimmed, (candidate) => candidate.label),
    );
  }, [choices, filter, query]);
  return (
    <Combobox<WorkPickerChoice>
      items={choices}
      filteredItems={filtered}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={open && !pending}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery("");
      }}
      value={null}
      onValueChange={(item) => {
        if (!item) return;
        setOpen(false);
        if (item.value === ADD_REPOSITORY) {
          openCommandPalette({ open: "add-project" });
          return;
        }
        void startWork({
          threadRef,
          choice: item.value,
          ...(throughMessageId === undefined ? {} : { throughMessageId }),
        });
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={<ComboboxTrigger render={props.trigger} disabled={pending} aria-busy={pending} />}
        >
          {props.children(pending)}
        </TooltipTrigger>
        <TooltipPopup side="top">{pending ? "Starting Work…" : props.tooltip}</TooltipPopup>
      </Tooltip>
      <ComboboxPopup align="start" className="w-72">
        <ComboboxSearchInput
          aria-label="Search repositories"
          placeholder="Start Work in…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>No matching repositories.</ComboboxEmpty>
        <ComboboxList>
          {(item: WorkPickerChoice) => (
            <ComboboxItem
              key={item.value}
              hideIndicator
              value={item}
              tone={item.value === ADD_REPOSITORY ? "action" : "default"}
              divider={item.value === ADD_REPOSITORY}
            >
              <ComboboxItemIcon>
                <WorkPickerChoiceIcon choice={item} />
              </ComboboxItemIcon>
              <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

/** A picker row's leading mark: the repository icon, or the no-repository and add icons. */
export function WorkPickerChoiceIcon({
  choice,
  className,
}: {
  readonly choice: WorkPickerChoice;
  readonly className?: string;
}) {
  if (choice.value === ADD_REPOSITORY) return <FolderPlusIcon className={className ?? "size-4"} />;
  if (choice.value === NO_REPOSITORY) {
    return <MessageSquareDashedIcon className={className ?? "size-4"} />;
  }
  return choice.repository ? (
    <ProjectFavicon project={choice.repository} className={className ?? "size-4"} />
  ) : (
    <FolderGit2Icon className={className ?? "size-4"} />
  );
}

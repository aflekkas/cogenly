import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@cogenly/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import {
  CommandId,
  type MessageId,
  type EnvironmentId,
  type ScopedThreadRef,
  WorkHandoffError,
} from "@cogenly/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon, FolderPlusIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { type ReactElement, type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { create } from "zustand";

import { requestLaunchMachine } from "~/machines/LaunchMachineDialog";
import { openCommandPalette } from "~/commandPaletteBus";
import { ProjectFolderIcon } from "~/projectLabels/ProjectFolderMark";
import {
  chatAddRepositoryTarget,
  type EnvironmentProjectLabel,
  projectLabelsOn,
  scopedRepositoryKey,
} from "~/projectLabels/projectLabels.logic";
import { linkedRepositoryIcon } from "~/projectLabels/repositoryPicker.logic";
import {
  ManageRepositoriesRowContent,
  ProjectFolderRowIcon,
  RepositoryPickerRow,
  RepositoryRowIcon,
} from "~/projectLabels/RepositorySourceRows";
import { useProjectLabelDirectory } from "~/projectLabels/useProjectLabels";
import { useRepositoryNames } from "~/projectLabels/useRepositoryNames";
import {
  RepositoryPickerGroupContent,
  useRepositoryPicker,
  type RepositoryPickerGroup,
  type RepositoryPickerItem,
} from "~/projectLabels/useRepositoryPicker";
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
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupItems,
  ComboboxItem,
  ComboboxItemIcon,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ADD_REPOSITORY,
  describeWorkStartFailure,
  disabledWorkProviderMessage,
  groupWorkChoicesByProject,
  listWorkPickerChoices,
  listWorkRepositories,
  NO_REPOSITORY,
  openWorkWhenArrived,
  type WorkPickerChoice,
  type WorkProjectGroup,
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
  readonly machine?: EnvironmentId;
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
  const serverConfigs = useServerConfigs();
  const startWork = useAtomCommand(serverEnvironment.startWork, { reportFailure: false });
  const { openScratchProject } = useScratchProject();
  return useCallback(
    async function start({
      threadRef,
      choice,
      throughMessageId,
      announce = false,
      machine: selectedMachine,
    }: StartWorkRequest) {
      const key = scopedThreadKey(threadRef);
      if (usePendingStarts.getState().pending.has(key)) return;
      setPending(key, true);
      let progressToast: ReturnType<typeof toastManager.add> | null = null;
      try {
        const { environmentId } = threadRef;
        const machine = selectedMachine ?? (await requestLaunchMachine(environmentId));
        if (machine === null) return;
        // Only once the machine is chosen: the "Run on" dialog is still asking until then.
        if (announce) {
          progressToast = toastManager.add({
            type: "loading",
            title: "Starting Work…",
            timeout: 0,
          });
        }
        // "No repository" is the environment's scratch project, created on first use.
        const targetProjectId =
          choice === NO_REPOSITORY ? (await openScratchProject(environmentId))?.id : choice;
        if (targetProjectId === undefined) return;
        const attemptKey = `${key}|${throughMessageId ?? ""}|${targetProjectId}|${machine}`;
        const commandId = retryCommandIds.get(attemptKey) ?? CommandId.make(randomUUID());
        retryCommandIds.set(attemptKey, commandId);
        const result = await startWork({
          environmentId,
          input: {
            commandId,
            sourceThreadId: threadRef.threadId,
            targetProjectId,
            ...(machine === environmentId ? {} : { machine }),
            ...(throughMessageId === undefined ? {} : { throughMessageId }),
          },
        });
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          const failure = squashAtomCommandFailure(result);
          const disabledInstanceId = isWorkHandoffError(failure)
            ? failure.disabledProviderInstanceId
            : undefined;
          const described = describeWorkStartFailure(
            isWorkHandoffError(failure) ? failure.stage : null,
          );
          if (!described.retryWithSameCommand) retryCommandIds.delete(attemptKey);
          toastManager.add({
            type: "error",
            title: "Could not start Work",
            description:
              isWorkHandoffError(failure) && failure.machineOffline
                ? "That machine is offline. Nothing was queued."
                : disabledInstanceId !== undefined
                  ? disabledWorkProviderMessage(
                      disabledInstanceId,
                      serverConfigs.get(machine)?.providers ?? [],
                    )
                  : described.message,
            ...(isWorkHandoffError(failure) && failure.machineOffline
              ? {
                  actionProps: {
                    children: "Run on this machine",
                    onClick: () => {
                      void start({
                        threadRef,
                        choice,
                        ...(throughMessageId === undefined ? {} : { throughMessageId }),
                        announce,
                        machine: environmentId,
                      });
                    },
                  },
                }
              : disabledInstanceId !== undefined
                ? {
                    actionProps: {
                      children: "Provider settings",
                      onClick: () => {
                        void navigate({
                          to: "/settings/providers",
                          search: { environmentId: machine, instanceId: disabledInstanceId },
                        });
                      },
                    },
                  }
                : {}),
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
    [navigate, openScratchProject, startWork, serverConfigs],
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
  const nameOf = useRepositoryNames();
  return useMemo(
    () =>
      listWorkPickerChoices({
        repositories: listWorkRepositories(projects, threadRef.environmentId, scratchWorkspaceRoot),
        sourceProjectId: thread?.projectId ?? null,
        canRunWithoutRepository: scratchWorkspaceRoot != null,
        nameOf,
      }),
    [nameOf, projects, scratchWorkspaceRoot, thread?.projectId, threadRef.environmentId],
  );
}

/** A Start Work picker row of its own: a project to open, the way back, a place to start, or Manage. */
type StartWorkRow =
  | {
      readonly kind: "project";
      readonly value: string;
      readonly label: string;
      readonly group: WorkProjectGroup<EnvironmentProjectLabel>;
    }
  | { readonly kind: "all-projects"; readonly value: string; readonly label: string }
  | {
      readonly kind: "manage";
      readonly value: string;
      readonly label: string;
      readonly project: EnvironmentProjectLabel;
    }
  | {
      readonly kind: "choice";
      readonly value: string;
      readonly label: string;
      readonly choice: WorkPickerChoice;
      /** The project a repository row's repository is in, for its icon. */
      readonly project: EnvironmentProjectLabel | null;
    };
type StartWorkItem = StartWorkRow | RepositoryPickerItem;

interface StartWorkGroup {
  readonly value: string;
  readonly items: ReadonlyArray<StartWorkItem>;
  /** Set on the shared repository list's groups, which render themselves. */
  readonly shared?: RepositoryPickerGroup;
}

const NO_PROJECT_KEY = "no-project";
const ALL_PROJECTS_VALUE = "all-projects";
const PROJECTS_GROUP = "projects";
const ACTIONS_GROUP = "actions";
const MANAGE_GROUP = "manage";

const choiceItem = (
  choice: WorkPickerChoice,
  project: EnvironmentProjectLabel | null = null,
): StartWorkItem => ({
  kind: "choice",
  value: `choice:${choice.value}`,
  label: choice.label,
  choice,
  project,
});

/**
 * The chat's "Start Work in…" picker, anchored under `trigger`. It lists
 * projects first; a project's › (click, Enter or →) opens the shared
 * repository list for the chat's machine (every repository the project
 * links, with its state there, and "Add repository"), and ← or the back row
 * returns. Typing searches every repository and project at once. A picked
 * repository starts Work; one not cloned on this machine is cloned first.
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
  const thread = useThreadShell(threadRef);
  const choices = useWorkPickerChoices(threadRef);
  const startWork = useStartWork();
  const pending = useStartWorkPending(threadRef);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [openProjectKey, setOpenProjectKey] = useState<string | null>(null);
  const keepOpenRef = useRef(false);
  const highlightedRef = useRef<StartWorkItem | null>(null);
  const filter = useComboboxFilter();

  // Work runs on the chat's machine, so only that machine's projects list.
  const environmentIds = useMemo(() => [threadRef.environmentId], [threadRef.environmentId]);
  const directory = useProjectLabelDirectory(environmentIds);
  const projectGroups = useMemo(() => {
    const projects = projectLabelsOn(directory.active, threadRef.environmentId);
    const activeKeys = new Set(projects.map((project) => project.key));
    return groupWorkChoicesByProject({
      choices,
      projects,
      projectOf: (projectId) => {
        const project = directory.folderByRepository.get(
          scopedRepositoryKey(threadRef.environmentId, projectId),
        );
        return project && activeKeys.has(project.key) ? project : null;
      },
      sourceProjectId: thread?.projectId ?? null,
    });
  }, [choices, directory, thread?.projectId, threadRef.environmentId]);
  const openGroup =
    openProjectKey === null
      ? null
      : (projectGroups.find((group) => (group.key ?? NO_PROJECT_KEY) === openProjectKey) ?? null);
  const openProject = openGroup?.project ?? null;

  const navigate = useNavigate();
  // "Add repository" keeps the handoff: the repository it adds starts this Work.
  const startWorkFrom = useMemo(
    () => ({ threadRef, ...(throughMessageId === undefined ? {} : { throughMessageId }) }),
    [threadRef, throughMessageId],
  );
  // The top-level "Add repository" files the new repository in the chat's
  // project, as the project's own "Add repository" does.
  const addRepositoryInto = thread ? chatAddRepositoryTarget(thread, directory.byKey) : null;
  const closePicker = () => {
    setOpen(false);
    setQuery("");
    setOpenProjectKey(null);
  };
  const repositoryPicker = useRepositoryPicker({
    environmentId: threadRef.environmentId,
    project: openProject,
    // "No project" opens the repositories in none.
    unfiledOnly: true,
    open: open && openGroup !== null,
    query,
    leadRepositoryId: thread?.projectId ?? null,
    startWorkFrom,
    onPickUncloned: (choice) => {
      closePicker();
      void startWork({
        threadRef,
        choice,
        ...(throughMessageId === undefined ? {} : { throughMessageId }),
      });
    },
    onPick: (repository) => {
      closePicker();
      void startWork({
        threadRef,
        choice: repository.id,
        ...(throughMessageId === undefined ? {} : { throughMessageId }),
      });
    },
    onClose: closePicker,
  });

  const groups = useMemo((): StartWorkGroup[] => {
    const trimmed = query.trim();
    const matches = (label: string) =>
      trimmed.length === 0 || filter.contains(label, trimmed, (candidate) => candidate);
    if (openGroup === null) {
      const extras = choices.filter(
        (choice) => choice.value === NO_REPOSITORY || choice.value === ADD_REPOSITORY,
      );
      const projectRows: StartWorkItem[] = projectGroups
        .map((group) => ({
          kind: "project" as const,
          value: `project:${group.key ?? NO_PROJECT_KEY}`,
          label: group.project?.label.name ?? "No project",
          group,
        }))
        .filter((row) => matches(row.label));
      // A search reaches into every project: its repositories list flat.
      const repositoryRows =
        trimmed.length === 0
          ? []
          : projectGroups.flatMap((group) =>
              group.choices
                .filter((c) => matches(c.label))
                .map((choice) => choiceItem(choice, group.project ?? null)),
            );
      const actionRows = extras
        .filter((choice) => choice.value !== ADD_REPOSITORY || trimmed.length === 0)
        .filter((choice) => matches(choice.label))
        .map((choice) => choiceItem(choice));
      return [
        ...(projectRows.length > 0 ? [{ value: PROJECTS_GROUP, items: projectRows }] : []),
        ...(repositoryRows.length > 0 ? [{ value: "repositories", items: repositoryRows }] : []),
        ...(actionRows.length > 0 ? [{ value: ACTIONS_GROUP, items: actionRows }] : []),
      ];
    }
    const listing = repositoryPicker.mode === "list";
    return [
      // "Add repository" brings its own way back.
      ...(listing
        ? [
            {
              value: ALL_PROJECTS_VALUE,
              items: [
                { kind: "all-projects" as const, value: ALL_PROJECTS_VALUE, label: "All projects" },
              ],
            },
          ]
        : []),
      ...repositoryPicker.groups.map((group) => ({
        value: group.value,
        items: group.items,
        shared: group,
      })),
      // The project's page in Settings lists, removes and adds its repositories.
      ...(listing && openProject !== null && trimmed.length === 0
        ? [
            {
              value: MANAGE_GROUP,
              items: [
                {
                  kind: "manage" as const,
                  value: MANAGE_GROUP,
                  label: "Manage repositories…",
                  project: openProject,
                },
              ],
            },
          ]
        : []),
    ];
  }, [
    choices,
    filter,
    openGroup,
    openProject,
    projectGroups,
    query,
    repositoryPicker.groups,
    repositoryPicker.mode,
  ]);

  const showProject = (key: string | null) => {
    setOpenProjectKey(key);
    setQuery("");
    repositoryPicker.reset();
  };
  const pick = (item: StartWorkItem) => {
    switch (item.kind) {
      case "project":
        keepOpenRef.current = true;
        showProject(item.group.key ?? NO_PROJECT_KEY);
        return;
      case "all-projects":
        keepOpenRef.current = true;
        showProject(null);
        return;
      case "manage":
        closePicker();
        void navigate({
          to: "/settings/project-tags",
          search: {
            projectEnvironmentId: item.project.environmentId,
            projectLabelId: item.project.label.id,
          },
        });
        return;
      case "choice":
        closePicker();
        if (item.choice.value === ADD_REPOSITORY) {
          openCommandPalette({
            open: "add-project",
            startWorkFrom,
            ...(addRepositoryInto ? { into: addRepositoryInto } : {}),
          });
          return;
        }
        void startWork({
          threadRef,
          choice: item.choice.value,
          ...(throughMessageId === undefined ? {} : { throughMessageId }),
        });
        return;
      default:
        if (repositoryPicker.pick(item)) {
          keepOpenRef.current = true;
          setQuery("");
        }
    }
  };

  const renderItem = (item: StartWorkItem) => {
    switch (item.kind) {
      case "manage":
        return (
          <ComboboxItem key={item.value} hideIndicator value={item} tone="action">
            <ManageRepositoriesRowContent />
          </ComboboxItem>
        );
      case "project":
      case "all-projects":
      case "choice": {
        // A repository row found by search reads like the project's own list.
        if (item.kind === "choice" && item.choice.repository !== undefined) {
          return (
            <RepositoryPickerRow
              key={item.value}
              item={item}
              icon={<WorkPickerChoiceIcon choice={item.choice} project={item.project} />}
              name={item.label}
            />
          );
        }
        const isAdd = item.kind === "choice" && item.choice.value === ADD_REPOSITORY;
        return (
          <ComboboxItem
            key={item.value}
            hideIndicator
            value={item}
            tone={isAdd || item.kind === "all-projects" ? "action" : "default"}
            divider={isAdd}
          >
            <ComboboxItemIcon>
              {item.kind === "project" ? (
                <ProjectFolderIcon project={item.group.project} className="size-4" />
              ) : item.kind === "all-projects" ? (
                <ChevronLeftIcon className="size-4" />
              ) : (
                <WorkPickerChoiceIcon choice={item.choice} />
              )}
            </ComboboxItemIcon>
            <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
            {item.kind === "project" ? (
              <ChevronRightIcon aria-hidden className="ml-auto size-3.5 shrink-0" />
            ) : null}
          </ComboboxItem>
        );
      }
      default:
        return repositoryPicker.renderItem(item);
    }
  };

  return (
    <Combobox
      items={groups}
      filteredItems={groups}
      autoHighlight
      itemToStringLabel={(item: StartWorkItem) => item.label}
      isItemEqualToValue={(a: StartWorkItem, b: StartWorkItem) => a.value === b.value}
      onItemHighlighted={(item: StartWorkItem | undefined) => {
        highlightedRef.current = item ?? null;
      }}
      open={open && !pending}
      onOpenChange={(next, details) => {
        // Opening a project, going back, adding or cloning keeps the picker up.
        if (!next && details.reason === "item-press" && keepOpenRef.current) {
          keepOpenRef.current = false;
          return;
        }
        setOpen(next);
        setQuery("");
        if (!next) {
          setOpenProjectKey(null);
          repositoryPicker.reset();
        }
      }}
      value={null}
      onValueChange={(item: StartWorkItem | null) => {
        if (item) pick(item);
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
      <ComboboxPopup align="start" className="w-72" animateHeight>
        <ComboboxSearchInput
          aria-label={openGroup ? "Search repositories" : "Search projects and repositories"}
          placeholder={
            openGroup === null
              ? "Start Work in…"
              : repositoryPicker.mode === "add"
                ? repositoryPicker.searchPlaceholder
                : `Start Work in ${openGroup.project?.label.name ?? "a repository"}…`
          }
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (repositoryPicker.onSearchKeyDown(event)) return;
            const input = event.currentTarget;
            const atEnd = input.selectionStart === input.value.length;
            const highlighted = highlightedRef.current;
            if (event.key === "ArrowRight" && atEnd && highlighted?.kind === "project") {
              event.preventDefault();
              showProject(highlighted.group.key ?? NO_PROJECT_KEY);
            } else if (
              (event.key === "ArrowLeft" || event.key === "Backspace") &&
              input.value.length === 0 &&
              openGroup !== null
            ) {
              event.preventDefault();
              showProject(null);
            }
          }}
        />
        <ComboboxEmpty>
          {openGroup === null ? "No matching repositories." : repositoryPicker.emptyText}
        </ComboboxEmpty>
        <ComboboxList>
          {(group: StartWorkGroup) => (
            <ComboboxGroup
              key={group.value}
              items={group.items}
              className={
                group.value === ACTIONS_GROUP ||
                group.value === MANAGE_GROUP ||
                group.shared?.tight === true
                  ? "not-first:mt-0"
                  : undefined
              }
            >
              {/* A project opening or closing, or "Add repository", swaps the rows in with a fade. */}
              <div
                key={`${openProjectKey ?? ""}:${repositoryPicker.mode}`}
                className="reveal-motion"
              >
                {group.shared ? (
                  <RepositoryPickerGroupContent
                    group={group.shared}
                    renderItem={repositoryPicker.renderItem}
                  />
                ) : (
                  <ComboboxGroupItems inset={false}>
                    <ComboboxCollection>
                      {(item: StartWorkItem) => renderItem(item)}
                    </ComboboxCollection>
                  </ComboboxGroupItems>
                )}
              </div>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

/**
 * A picker row's leading mark: the shared repository icon (resolved through
 * the link `project` holds, when given), or the no-repository and add icons.
 */
export function WorkPickerChoiceIcon({
  choice,
  project = null,
  className,
}: {
  readonly choice: WorkPickerChoice;
  readonly project?: EnvironmentProjectLabel | null;
  readonly className?: string;
}) {
  if (choice.value === ADD_REPOSITORY) return <FolderPlusIcon className={className ?? "size-4"} />;
  if (choice.value === NO_REPOSITORY) {
    return <ProjectFolderRowIcon {...(className === undefined ? {} : { className })} />;
  }
  const { remote, iconPath } = linkedRepositoryIcon(project, choice.value);
  return (
    <RepositoryRowIcon
      local={choice.repository ?? null}
      remote={remote}
      environmentId={choice.repository?.environmentId ?? project?.environmentId ?? null}
      iconPath={iconPath}
      {...(className === undefined ? {} : { className })}
    />
  );
}

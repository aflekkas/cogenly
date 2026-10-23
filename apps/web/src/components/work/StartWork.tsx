import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type MessageId,
  resolveEnvironmentMachineKind,
  type ScopedThreadRef,
  WorkHandoffError,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  FolderPlusIcon,
  MessageSquareDashedIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { create } from "zustand";

import { openCommandPalette } from "~/commandPaletteBus";
import { ProjectFolderIcon } from "~/projectLabels/ProjectFolderMark";
import {
  type EnvironmentProjectLabel,
  scopedRepositoryKey,
} from "~/projectLabels/projectLabels.logic";
import {
  linkedGitHubOwners,
  type OwnerSearchState,
} from "~/projectLabels/projectSourceLinks.logic";
import { remoteSectionRows } from "~/projectLabels/repositoryPicker.logic";
import {
  LocalRepositoryRowEnd,
  ManageRepositoriesRowContent,
  RemoteRepositoryRow,
  RemoteRepositorySection,
  RepositorySourceLabel,
  ShowMoreRemoteRow,
} from "~/projectLabels/RepositorySourceRows";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import {
  useCanRemoveRepositoryFromProject,
  useRemoveRepositoryFromProject,
} from "~/projectLabels/useRemoveRepositoryFromProject";
import { useOwnerRepositorySearch } from "~/projectLabels/useOwnerRepositorySearch";
import { useProjectLabelDirectory } from "~/projectLabels/useProjectLabels";
import {
  type RemoteCloneTarget,
  useRemoteRepositoryClone,
} from "~/projectLabels/useRemoteRepositoryClone";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
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
import { ProjectFavicon } from "../ProjectFavicon";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ADD_REPOSITORY,
  describeWorkStartFailure,
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

/** A Start Work picker row: a project to open, the way back, a place to start, or a GitHub result. */
type StartWorkItem =
  | {
      readonly kind: "project";
      readonly value: string;
      readonly label: string;
      readonly group: WorkProjectGroup<EnvironmentProjectLabel>;
    }
  | { readonly kind: "back"; readonly value: string; readonly label: string }
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
    }
  | {
      readonly kind: "remote";
      readonly value: string;
      readonly label: string;
      readonly remote: RemoteCloneTarget;
    }
  | {
      /** The GitHub section's "Show more" row. */
      readonly kind: "more";
      readonly value: string;
      readonly label: string;
      readonly hidden: number;
    };

interface StartWorkGroup {
  readonly value: string;
  /** The chat's machine over a project's own repositories; the rest have no header. */
  readonly label: string | null;
  readonly items: ReadonlyArray<StartWorkItem>;
  /** The project's GitHub results, searched while the project is open. */
  readonly remote?: { readonly project: EnvironmentProjectLabel; readonly state: OwnerSearchState };
}

const NO_PROJECT_KEY = "no-project";
const BACK_VALUE = "back";
const PROJECTS_GROUP = "projects";
const ACTIONS_GROUP = "actions";

const choiceItem = (choice: WorkPickerChoice): StartWorkItem => ({
  kind: "choice",
  value: `choice:${choice.value}`,
  label: choice.label,
  choice,
});

/**
 * The chat's "Start Work in…" picker, anchored under `trigger`. It lists
 * projects first; a project's › (click, Enter or →) opens its repositories,
 * those on this machine and its GitHub repositories, and ← or the back row
 * returns. Typing searches every repository and project at once. A picked
 * repository starts Work; a GitHub one is cloned into its project first.
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
  const machineKind = resolveEnvironmentMachineKind(
    useServerConfigs().get(threadRef.environmentId) ?? null,
  );
  // Work runs on the chat's machine; its repositories are named as being there.
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const machineLabel = environments.find(
    (environment) => environment.environmentId === threadRef.environmentId,
  )?.label;
  const machineSectionLabel = machineLabel
    ? `On ${machineLabel}`
    : threadRef.environmentId === primaryEnvironmentId
      ? "On this machine"
      : "On another machine";
  const [showAllRemote, setShowAllRemote] = useState(false);

  // Work runs on the chat's machine, so only that machine's projects list.
  const environmentIds = useMemo(() => [threadRef.environmentId], [threadRef.environmentId]);
  const directory = useProjectLabelDirectory(environmentIds);
  const projectGroups = useMemo(() => {
    const projects = directory.active.filter(
      (project) => project.environmentId === threadRef.environmentId,
    );
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
  const canRemoveRepository = useCanRemoveRepositoryFromProject(threadRef.environmentId);
  const removeRepositoryFromProject = useRemoveRepositoryFromProject();
  const searchedProjects = useMemo(() => (openProject ? [openProject] : []), [openProject]);
  const ownerSearch = useOwnerRepositorySearch(searchedProjects, query, open && !!openProject);
  const remoteSearch = openProject ? ownerSearch.get(openProject.key) : undefined;

  const groups = useMemo((): StartWorkGroup[] => {
    const trimmed = query.trim();
    const matches = (label: string) =>
      trimmed.length === 0 || filter.contains(label, trimmed, (candidate) => candidate);
    const extras = choices.filter(
      (choice) => choice.value === NO_REPOSITORY || choice.value === ADD_REPOSITORY,
    );
    const actions = (rows: ReadonlyArray<WorkPickerChoice>): StartWorkGroup[] => {
      const items = rows
        .filter((choice) => choice.value !== ADD_REPOSITORY || trimmed.length === 0)
        .filter((choice) => matches(choice.label))
        .map(choiceItem);
      return items.length > 0 ? [{ value: ACTIONS_GROUP, label: null, items }] : [];
    };
    if (openGroup === null) {
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
          : projectGroups.flatMap((group) => group.choices.filter((c) => matches(c.label)));
      return [
        ...(projectRows.length > 0
          ? [{ value: PROJECTS_GROUP, label: null, items: projectRows }]
          : []),
        ...(repositoryRows.length > 0
          ? [{ value: "repositories", label: null, items: repositoryRows.map(choiceItem) }]
          : []),
        ...actions(extras),
      ];
    }
    const groupKey = openGroup.key ?? NO_PROJECT_KEY;
    const back: StartWorkGroup = {
      value: BACK_VALUE,
      label: null,
      items: [{ kind: "back", value: BACK_VALUE, label: "All projects" }],
    };
    const local = openGroup.choices.filter((choice) => matches(choice.label)).map(choiceItem);
    // A repository shows once: a clone the project holds wins over its GitHub row.
    const remoteSection =
      remoteSearch?.status === "done"
        ? remoteSectionRows({
            repositories: remoteSearch.repositories,
            local: openGroup.choices.map((choice) => choice.repository?.repositoryIdentity),
            searching: trimmed.length > 0,
            expanded: showAllRemote,
          })
        : { rows: [], hidden: 0 };
    const showRemote =
      openProject !== null &&
      remoteSearch !== undefined &&
      (remoteSearch.status !== "done" || remoteSection.rows.length > 0);
    // "Add repository…", then the project's page in Settings, which lists,
    // removes and adds its repositories.
    const openActions: StartWorkItem[] = [
      ...(actions(extras.filter((choice) => choice.value === ADD_REPOSITORY))[0]?.items ?? []),
      ...(openProject !== null && trimmed.length === 0
        ? [
            {
              kind: "manage" as const,
              value: "manage",
              label: "Manage repositories…",
              project: openProject,
            },
          ]
        : []),
    ];
    return [
      back,
      ...(local.length > 0
        ? [
            {
              value: `local:${groupKey}`,
              label: showRemote ? machineSectionLabel : null,
              items: local,
            },
          ]
        : []),
      ...(showRemote && openProject !== null && remoteSearch !== undefined
        ? [
            {
              value: `remote:${groupKey}`,
              label: "On GitHub",
              remote: { project: openProject, state: remoteSearch },
              items: [
                ...remoteSection.rows.map(({ repository, label }): StartWorkItem => ({
                  kind: "remote",
                  value: `remote:${groupKey}|${repository.nameWithOwner}`,
                  label,
                  remote: { project: openProject, repository },
                })),
                ...(remoteSection.hidden > 0
                  ? [
                      {
                        kind: "more" as const,
                        value: `remote:${groupKey}|more`,
                        label: `Show ${remoteSection.hidden} more`,
                        hidden: remoteSection.hidden,
                      },
                    ]
                  : []),
              ],
            },
          ]
        : []),
      ...(openActions.length > 0
        ? [{ value: ACTIONS_GROUP, label: null, items: openActions }]
        : []),
    ];
  }, [
    choices,
    filter,
    machineSectionLabel,
    openGroup,
    openProject,
    projectGroups,
    query,
    remoteSearch,
    showAllRemote,
  ]);

  const remoteClone = useRemoteRepositoryClone(
    (target) =>
      open &&
      groups.some((group) =>
        group.items.some(
          (item) =>
            item.kind === "remote" &&
            item.remote.project.key === target.project.key &&
            item.remote.repository.nameWithOwner === target.repository.nameWithOwner,
        ),
      ),
  );
  // A GitHub repository picked here is cloned into its project; once it
  // lands, Work starts in it.
  const startAfterCloneRef = useRef(false);
  const clonedRef = remoteClone.view?.phase === "done" ? remoteClone.ref : null;
  useEffect(() => {
    if (clonedRef === null) return;
    const startNow = startAfterCloneRef.current;
    startAfterCloneRef.current = false;
    remoteClone.release();
    if (!startNow) return;
    setOpen(false);
    void startWork({
      threadRef,
      choice: clonedRef.projectId,
      announce: true,
      ...(throughMessageId === undefined ? {} : { throughMessageId }),
    });
  });

  const showProject = (key: string | null) => {
    setOpenProjectKey(key);
    setQuery("");
    setShowAllRemote(false);
  };
  const pick = (item: StartWorkItem) => {
    if (item.kind === "more") {
      keepOpenRef.current = true;
      setShowAllRemote(true);
      return;
    }
    if (item.kind === "project") {
      keepOpenRef.current = true;
      showProject(item.group.key ?? NO_PROJECT_KEY);
      return;
    }
    if (item.kind === "back") {
      keepOpenRef.current = true;
      showProject(null);
      return;
    }
    if (item.kind === "remote") {
      keepOpenRef.current = true;
      const view = remoteClone.isFor(item.remote) ? remoteClone.view : null;
      if (view?.phase === "starting" || view?.phase === "running") return;
      startAfterCloneRef.current = true;
      if (view?.phase === "failed" || view?.phase === "cancelled") {
        void remoteClone.retry();
        return;
      }
      void remoteClone.start(item.remote);
      return;
    }
    setOpen(false);
    if (item.kind === "manage") {
      void navigate({
        to: "/settings/project-tags",
        search: {
          projectEnvironmentId: item.project.environmentId,
          projectLabelId: item.project.label.id,
        },
      });
      return;
    }
    if (item.choice.value === ADD_REPOSITORY) {
      openCommandPalette(
        openProject
          ? {
              open: "add-project",
              into: { environmentId: openProject.environmentId, labelId: openProject.label.id },
            }
          : { open: "add-project" },
      );
      return;
    }
    void startWork({
      threadRef,
      choice: item.choice.value,
      ...(throughMessageId === undefined ? {} : { throughMessageId }),
    });
  };

  const renderItem = (item: StartWorkItem) => {
    if (item.kind === "more") {
      return <ShowMoreRemoteRow key={item.value} item={item} hidden={item.hidden} />;
    }
    if (item.kind === "remote") {
      return (
        <RemoteRepositoryRow
          key={item.value}
          item={item}
          repository={item.remote.repository}
          label={item.label}
          clone={remoteClone}
          view={remoteClone.isFor(item.remote) ? remoteClone.view : null}
        />
      );
    }
    if (item.kind === "manage") {
      return (
        <ComboboxItem key={item.value} hideIndicator value={item} tone="action">
          <ManageRepositoriesRowContent />
        </ComboboxItem>
      );
    }
    const isAdd = item.kind === "choice" && item.choice.value === ADD_REPOSITORY;
    // A repository row inside an open project, which the row can take out of it.
    const projectRepository =
      item.kind === "choice" && item.choice.repository && openProject !== null
        ? item.choice.repository
        : null;
    return (
      <ComboboxItem
        key={item.value}
        hideIndicator
        value={item}
        tone={isAdd || item.kind === "back" ? "action" : "default"}
        divider={isAdd}
      >
        <ComboboxItemIcon>
          {item.kind === "project" ? (
            <ProjectFolderIcon color={item.group.project?.label.color} className="size-4" />
          ) : item.kind === "back" ? (
            <ChevronLeftIcon className="size-4" />
          ) : (
            <WorkPickerChoiceIcon choice={item.choice} />
          )}
        </ComboboxItemIcon>
        <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
        {item.kind === "project" ? (
          <ChevronRightIcon aria-hidden className="ml-auto size-3.5 shrink-0" />
        ) : null}
        {item.kind === "choice" && item.choice.repository ? (
          <LocalRepositoryRowEnd
            identity={item.choice.repository.repositoryIdentity}
            removeLabel={`Remove ${item.label} from ${openProject?.label.name ?? "its project"}`}
            {...(projectRepository !== null &&
            openProject !== null &&
            canRemoveRepository &&
            openProject.label.repositoryIds.includes(projectRepository.id)
              ? {
                  onRemove: () => {
                    setOpen(false);
                    void removeRepositoryFromProject({
                      project: openProject,
                      repositoryId: projectRepository.id,
                      title: item.label,
                    });
                  },
                }
              : {})}
          />
        ) : null}
      </ComboboxItem>
    );
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
        // Opening a project, going back, or cloning keeps the picker up.
        if (!next && details.reason === "item-press" && keepOpenRef.current) {
          keepOpenRef.current = false;
          return;
        }
        setOpen(next);
        setQuery("");
        if (!next) {
          setOpenProjectKey(null);
          setShowAllRemote(false);
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
            openGroup
              ? `Start Work in ${openGroup.project?.label.name ?? "a repository"}…`
              : "Start Work in…"
          }
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
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
          {remoteSearch?.status === "loading" ? null : "No matching repositories."}
        </ComboboxEmpty>
        <ComboboxList>
          {(group: StartWorkGroup) => (
            <ComboboxGroup
              key={group.value}
              items={group.items}
              className={group.value === ACTIONS_GROUP ? "not-first:mt-0" : undefined}
            >
              {/* A project opening or closing swaps the rows in with a fade. */}
              <div className="reveal-motion">
                {group.remote ? (
                  <RemoteRepositorySection
                    state={group.remote.state}
                    owners={linkedGitHubOwners(group.remote.project)}
                    renderItem={renderItem}
                  />
                ) : (
                  <>
                    {group.label ? (
                      <RepositorySourceLabel
                        icon={
                          <EnvironmentMachineIcon
                            aria-hidden
                            kind={machineKind}
                            className="size-3"
                          />
                        }
                        label={group.label}
                      />
                    ) : null}
                    <ComboboxGroupItems
                      inset={group.label !== null}
                      afterHeader={group.label !== null}
                    >
                      <ComboboxCollection>
                        {(item: StartWorkItem) => renderItem(item)}
                      </ComboboxCollection>
                    </ComboboxGroupItems>
                  </>
                )}
              </div>
            </ComboboxGroup>
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

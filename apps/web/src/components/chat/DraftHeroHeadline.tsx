import type { DraftId } from "~/composerDraftStore";
import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
import {
  type EnvironmentId,
  type ProjectLabelOwnerRepository,
  resolveEnvironmentMachineKind,
  type ScopedProjectRef,
  type ThreadId,
  type ThreadSurface,
} from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, FolderGit2Icon, FolderPlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useClientSettings } from "~/hooks/useSettings";
import { hasExplicitComposerModelSelection } from "~/lib/chatThreadActions";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  setPendingProjectFolder,
  usePendingProjectFolderStore,
} from "~/projectLabels/pendingProjectFolders";
import {
  projectLabelKey,
  scopedRepositoryKey,
  type EnvironmentProjectLabel,
} from "~/projectLabels/projectLabels.logic";
import {
  heroProjectSuffix,
  isPickableRepository,
  projectDefaultRepository,
  repositoriesInProject,
  workDraftFolderId,
  workHeroBreadcrumb,
  workHeroLine,
} from "~/projectLabels/projectMeta.logic";
import { ComposerProjectPicker } from "~/projectLabels/ComposerProjectPicker";
import {
  linkedGitHubOwners,
  type OwnerSearchState,
} from "~/projectLabels/projectSourceLinks.logic";
import {
  groupRepositoriesByMachine,
  remoteSectionRows,
} from "~/projectLabels/repositoryPicker.logic";
import {
  LocalRepositoryRowEnd,
  ManageRepositoriesRowContent,
  ProjectFolderRowIcon,
  RemoteRepositoryRow,
  RemoteRepositorySection,
  RepositorySourceLabel,
  ShowMoreRemoteRow,
} from "~/projectLabels/RepositorySourceRows";
import {
  useCanRemoveRepositoryFromProject,
  useRemoveRepositoryFromProject,
} from "~/projectLabels/useRemoveRepositoryFromProject";
import { useOwnerRepositorySearch } from "~/projectLabels/useOwnerRepositorySearch";
import { useRemoteRepositoryClone } from "~/projectLabels/useRemoteRepositoryClone";
import { useProjectLabelDirectory } from "~/projectLabels/useProjectLabels";
import { answerNoProjectPick, useWorkNoProjectPicked } from "~/projectLabels/workNoProjectPicks";
import { chatGreeting } from "./chatGreeting";
import { FadeSwap } from "./StateTransition";
import { useHeroHeadlineMotion } from "./useHeroHeadlineMotion";
import { cn } from "~/lib/utils";
import { WorkHeroCrumbText, WorkHeroSentence } from "./WorkHeroSentence";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InlineButton } from "../ui/button";
import { ProjectFavicon } from "../ProjectFavicon";
import { RepositoryBadge } from "../sidebar/modes/RepositoryBadge";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

// Picker values for the action rows; repositories are keyed by their logical
// project key.
/** The draft heading's FadeSwap slot, which a replacing draft's heading picks up from. */
const DRAFT_HEADING_GROUP = "draft-heading";
const ADD_PROJECT_VALUE = "add-project";
const MANAGE_REPOSITORIES_VALUE = "manage-repositories";
const ACTIONS_GROUP_KEY = "actions";
const REPOSITORIES_GROUP_KEY = "repositories";
// Work without a repository (in the project's folder): the row that leads the picker.
const NO_REPOSITORY_VALUE = "no-repository";
const NO_REPOSITORY_GROUP_KEY = "no-repository";

type PickerEntry = ReturnType<typeof buildSidebarProjectPickerEntries>[number];

interface PickerItem {
  readonly value: string;
  readonly label: string;
  /** The logical project key; empty on action rows and GitHub results. */
  readonly projectKey: string;
  /** The project group the row is listed under. */
  readonly groupKey: string;
  /** A GitHub repository under a project's linked owner, not on this machine yet. */
  readonly remote?: {
    readonly project: EnvironmentProjectLabel;
    readonly repository: ProjectLabelOwnerRepository;
  };
  /** The GitHub section's "Show more" row, with how many results it hides. */
  readonly more?: number;
}

interface PickerGroup {
  readonly value: string;
  /** The header: the machine a run of repositories is on, or "On GitHub". */
  readonly label: string | null;
  /** The machine a section of the project's own repositories is on. */
  readonly environmentId?: EnvironmentId;
  readonly items: readonly PickerItem[];
  /** Set on the project's "On GitHub" section, which follows its own repositories. */
  readonly remote?: {
    readonly project: EnvironmentProjectLabel;
    readonly state: OwnerSearchState;
  };
}

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
  /** What the draft was started as; absent on drafts from before it was recorded. */
  readonly surface: ThreadSurface | undefined;
}

export function DraftHeroHeadline({
  draftId,
  activeProjectRef,
  activeProjectTitle,
  surface,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const applyStickyState = useComposerDraftStore((store) => store.applyStickyState);
  const setModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const openProjectDraft = useNewThreadHandler();
  const navigate = useNavigate();

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        buildSidebarProjectSnapshots({
          projects,
          settings: projectGroupingSettings,
          primaryEnvironmentId,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        }),
        threads,
        projectSortOrder,
      ),
    [
      environmentLabelById,
      primaryEnvironmentId,
      projectGroupingSettings,
      projectSortOrder,
      projects,
      threads,
    ],
  );
  const environmentMachineById = useMemo(
    () =>
      new Map(
        environments.map(
          (environment) =>
            [
              environment.environmentId,
              resolveEnvironmentMachineKind(environment.serverConfig),
            ] as const,
        ),
      ),
    [environments],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: activeProjectRef,
      }),
    [activeProjectRef, projectGroups],
  );
  const projectEntryByKey = useMemo(
    () => new Map(projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const)),
    [projectPickerEntries],
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  const activeProjectDisplayName = activeProjectGroup?.displayName ?? activeProjectTitle;
  // Whether a project is its machine's no-project home. Read from the
  // machine's config even while it reconnects: scratchWorkspaceRootFor is
  // null then, and the home would read as a project named "No project".
  const scratchRootOf = useCallback(
    (environmentId: EnvironmentId) =>
      scratchWorkspaceRootFor(environmentId) ??
      environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
        ?.scratchWorkspaceRoot,
    [environments, scratchWorkspaceRootFor],
  );
  const isNoProjectHome = useCallback(
    (project: { readonly environmentId: EnvironmentId; readonly workspaceRoot: string }) =>
      isScratchProject(project, scratchRootOf(project.environmentId)),
    [scratchRootOf],
  );
  // Only repositories are listed: the picker's "No repository" row is the way
  // into the no-project home. Any member that is not one (a home, a Scratch
  // thread folder, the home folder) keeps its group out.
  const menuEntries = useMemo(
    () =>
      projectPickerEntries.filter(
        ({ group, targetProject }) =>
          group.isScratch !== true &&
          [targetProject, ...group.memberProjects].every((project) =>
            isPickableRepository(project, scratchRootOf(project.environmentId)),
          ),
      ),
    [projectPickerEntries, scratchRootOf],
  );
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const scratchTargetEnvironmentId = scratchEnvironmentId(
    activeProjectRef?.environmentId ?? primaryEnvironmentId,
  );
  const scratchWorkspaceRoot = scratchWorkspaceRootFor(scratchTargetEnvironmentId);
  const isScratchDraft = activeProject !== null && isNoProjectHome(activeProject);
  // A chat is a quick conversation: no repository choice at all. Work may run
  // without a repository, and says so in the picker. Drafts from before the
  // surface was recorded keep the old guess.
  const isChatDraft = surface === undefined ? isScratchDraft : surface === "chat";

  // The repository picker lists the Work project's own repositories, or with
  // no project the ones in none. Folders live per environment; every
  // connected one contributes.
  const environmentIds = useMemo(
    () => environments.map((environment) => environment.environmentId),
    [environments],
  );
  const projectDirectory = useProjectLabelDirectory(environmentIds);
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.draftThreadsByThreadKey[draftId] : undefined,
  );
  const pendingFolder = usePendingProjectFolderStore((store) =>
    draftThread ? store.byThreadId[draftThread.threadId] : undefined,
  );
  const pendingProject =
    pendingFolder && pendingFolder.environmentId === draftThread?.environmentId
      ? (projectDirectory.byKey.get(
          projectLabelKey(pendingFolder.environmentId, pendingFolder.folderId),
        ) ?? null)
      : null;
  // Work's project: the one picked for the draft, else its repository's own,
  // which Work follows. It leads the sentence; the repository is picked in it.
  const repositoryFolder =
    activeProjectRef === null || isScratchDraft
      ? null
      : (projectDirectory.folderByRepository.get(
          scopedRepositoryKey(activeProjectRef.environmentId, activeProjectRef.projectId),
        ) ?? null);
  const workProject = isChatDraft ? null : (pendingProject ?? repositoryFolder);
  const workProjectKey = workProject?.key ?? null;
  const heroLine = workHeroLine({
    isChat: isChatDraft,
    hasProject: workProject !== null,
    hasRepository: !isScratchDraft,
    canStartWithoutRepository: scratchWorkspaceRoot !== null,
  });
  const showProjectFolderRow = heroLine.projectFolderRow !== "hidden";
  const breadcrumb = workHeroBreadcrumb({
    projectName: workProject?.label.name ?? null,
    repositoryName: activeProjectDisplayName,
    hasRepository: !isScratchDraft,
  });
  const repositoryItems = useMemo(
    () =>
      menuEntries.map(({ group }) => ({
        value: group.projectKey,
        label: group.displayName,
        projectKey: group.projectKey,
        groupKey: "",
      })),
    [menuEntries],
  );
  const refsOfRepository = useCallback(
    (item: PickerItem) => projectEntryByKey.get(item.projectKey)?.group.memberProjectRefs ?? [],
    [projectEntryByKey],
  );
  // Repositories belong to a project or to none: only the Work project's own
  // are offered (or, with no project, those in none), so a pick never
  // changes the project. The project picker does that.
  const scopedRepositoryItems = useMemo(
    () =>
      repositoriesInProject({
        items: repositoryItems,
        refsOf: refsOfRepository,
        project: workProject,
        projects: projectDirectory.active,
      }),
    [projectDirectory.active, refsOfRepository, repositoryItems, workProject],
  );
  // What the project's own checkouts answer to on GitHub, so its GitHub
  // results leave them out.
  const projectRepositoryIdentities = useMemo(
    () =>
      scopedRepositoryItems.flatMap(
        (item) =>
          projectEntryByKey
            .get(item.projectKey)
            ?.group.memberProjects.map((member) => member.repositoryIdentity) ?? [],
      ),
    [projectEntryByKey, scopedRepositoryItems],
  );
  const projectFolderRowLabel = heroLine.projectFolderRowLabel;
  // The GitHub section shows a short preview until "Show more"; a search lists all.
  const [showAllRemote, setShowAllRemote] = useState(false);
  // Each repository sits under the machine its checkout is on, named by that
  // machine's label, so a VPS clone never reads as "on this machine".
  const machineSectionLabel = useCallback(
    (environmentId: EnvironmentId) => {
      const label = environmentLabelById.get(environmentId);
      if (label) return `On ${label}`;
      return environmentId === primaryEnvironmentId ? "On this machine" : "On another machine";
    },
    [environmentLabelById, primaryEnvironmentId],
  );
  const buildPickerGroups = useCallback(
    (
      items: readonly PickerItem[],
      withActions: boolean,
      withProjectFolder: boolean,
      remote: OwnerSearchState | undefined = undefined,
      searching = false,
    ) => {
      const groups: PickerGroup[] = [];
      if (withProjectFolder) {
        groups.push({
          value: NO_REPOSITORY_GROUP_KEY,
          label: null,
          items: [
            {
              value: NO_REPOSITORY_VALUE,
              label: projectFolderRowLabel,
              projectKey: "",
              groupKey: NO_REPOSITORY_GROUP_KEY,
            },
          ],
        });
      }
      // The project's GitHub results follow its own repositories; while both
      // show, each source has its header so the machine's clones and GitHub's
      // repositories read apart. A repository shows once: a clone the project
      // holds (all of them, not just the search's matches) wins.
      const remoteSection =
        remote?.status === "done"
          ? remoteSectionRows({
              repositories: remote.repositories,
              local: projectRepositoryIdentities,
              searching,
              expanded: showAllRemote,
            })
          : { rows: [], hidden: 0 };
      const showRemote =
        workProject !== null &&
        remote !== undefined &&
        (remote.status !== "done" || remoteSection.rows.length > 0);
      const machineSections = groupRepositoriesByMachine(
        items.flatMap((item) => {
          const environmentId = projectEntryByKey.get(item.projectKey)?.targetProject.environmentId;
          return environmentId ? [{ item, environmentId }] : [];
        }),
        (entry) => entry.environmentId,
        primaryEnvironmentId,
      );
      // Headers only once there is more than one source to tell apart.
      const labelSections = showRemote || machineSections.length > 1;
      for (const section of machineSections) {
        const { environmentId } = section;
        const groupKey = `${REPOSITORIES_GROUP_KEY}:${environmentId}`;
        groups.push({
          value: groupKey,
          label: labelSections ? machineSectionLabel(environmentId) : null,
          environmentId,
          items: section.items.map(({ item }) => ({ ...item, groupKey })),
        });
      }
      if (showRemote && workProject !== null && remote !== undefined) {
        const groupKey = `remote:${workProject.key}`;
        groups.push({
          value: groupKey,
          label: "On GitHub",
          remote: { project: workProject, state: remote },
          items: [
            ...remoteSection.rows.map(({ repository, label }) => ({
              value: `${groupKey}|${repository.nameWithOwner}`,
              label,
              projectKey: "",
              groupKey,
              remote: { project: workProject, repository },
            })),
            ...(remoteSection.hidden > 0
              ? [
                  {
                    value: `${groupKey}|more`,
                    label: `Show ${remoteSection.hidden} more`,
                    projectKey: "",
                    groupKey,
                    more: remoteSection.hidden,
                  },
                ]
              : []),
          ],
        });
      }
      if (withActions) {
        groups.push({
          value: ACTIONS_GROUP_KEY,
          label: null,
          items: [
            {
              value: ADD_PROJECT_VALUE,
              label: "Add repository…",
              projectKey: "",
              groupKey: ACTIONS_GROUP_KEY,
            },
            // The project's page in Settings lists, removes and adds its repositories.
            ...(workProject !== null
              ? [
                  {
                    value: MANAGE_REPOSITORIES_VALUE,
                    label: "Manage repositories…",
                    projectKey: "",
                    groupKey: ACTIONS_GROUP_KEY,
                  },
                ]
              : []),
          ],
        });
      }
      return groups;
    },
    [
      machineSectionLabel,
      primaryEnvironmentId,
      projectEntryByKey,
      projectFolderRowLabel,
      projectRepositoryIdentities,
      showAllRemote,
      workProject,
    ],
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const keepPickerOpenRef = useRef(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerFilter = useComboboxFilter();
  // While open, the picker also lists the Work project's GitHub repositories:
  // its linked owners', else the signed-in account's; recent pushes until a search.
  const searchedProjects = useMemo(() => (workProject ? [workProject] : []), [workProject]);
  const ownerSearch = useOwnerRepositorySearch(searchedProjects, pickerQuery, pickerOpen);
  const remoteSearch = workProject ? ownerSearch.get(workProject.key) : undefined;
  const pickerGroups = useMemo(
    () => buildPickerGroups(scopedRepositoryItems, true, showProjectFolderRow, remoteSearch),
    [buildPickerGroups, remoteSearch, scopedRepositoryItems, showProjectFolderRow],
  );
  const filteredPickerGroups = useMemo(() => {
    const query = pickerQuery.trim();
    if (query.length === 0) return pickerGroups;
    return buildPickerGroups(
      scopedRepositoryItems.filter((item) =>
        pickerFilter.contains(item, query, (candidate) => candidate.label),
      ),
      false,
      showProjectFolderRow &&
        pickerFilter.contains(projectFolderRowLabel, query, (candidate) => candidate),
      remoteSearch,
      true,
    );
  }, [
    buildPickerGroups,
    remoteSearch,
    pickerFilter,
    pickerGroups,
    pickerQuery,
    projectFolderRowLabel,
    scopedRepositoryItems,
    showProjectFolderRow,
    workProject,
  ]);
  const searchingGitHub = filteredPickerGroups.some((group) => group.remote !== undefined);
  const remoteClone = useRemoteRepositoryClone(
    (target) =>
      pickerOpen &&
      filteredPickerGroups.some((group) =>
        group.items.some(
          (item) =>
            item.remote?.project.key === target.project.key &&
            item.remote.repository.nameWithOwner === target.repository.nameWithOwner,
        ),
      ),
  );
  const projectFolderItem =
    pickerGroups.find((group) => group.value === NO_REPOSITORY_GROUP_KEY)?.items[0] ?? null;
  const selectedPickerItem =
    heroLine.projectFolderRow === "selected"
      ? projectFolderItem
      : (pickerGroups
          .filter((group) => group.environmentId !== undefined)
          .flatMap((group) => group.items)
          .find((item) => item.projectKey === activeProjectKey) ?? null);

  // The picker can change the draft's target while the no-project home is
  // still being opened; a stale continuation must not retarget it again.
  const latestTargetRef = useRef({ draftId, activeProjectKey, scratchTargetEnvironmentId });
  useEffect(() => {
    latestTargetRef.current = { draftId, activeProjectKey, scratchTargetEnvironmentId };
  }, [activeProjectKey, scratchTargetEnvironmentId, draftId]);
  // With a prompt typed, project selection changes the target of the open
  // draft in place, so the prompt stays in the same composer session. An empty
  // draft instead opens the chosen project's own draft, like starting a new
  // thread there: moving it would replace that draft and strand whatever it
  // holds, such as the browser tabs of the no-project draft.
  // `folder` is the project the Work lands in; the draft records it unless
  // the repository's own project is that one, which Work follows anyway.
  const selectProject = (
    project: (typeof projects)[number],
    logicalProjectKey: string,
    folder: EnvironmentProjectLabel | null,
  ) => {
    if (!draftId) {
      return;
    }
    latestTargetRef.current = {
      draftId,
      activeProjectKey: logicalProjectKey,
      scratchTargetEnvironmentId: project.environmentId,
    };
    const folderId = workDraftFolderId({
      repository: { environmentId: project.environmentId, projectId: project.id },
      project: folder,
      folderByRepository: projectDirectory.folderByRepository,
    });
    const fileDraft = (threadId: ThreadId) =>
      setPendingProjectFolder(
        threadId,
        folderId === null ? null : { environmentId: project.environmentId, folderId },
      );
    const leavingThreadId = draftThread?.threadId ?? null;
    const currentDraft = getComposerDraft(draftId);
    if (!composerDraftHasUserContent(currentDraft)) {
      void openProjectDraft(
        scopeProjectRef(project.environmentId, project.id),
        surface ? { surface } : {},
      ).then((started) => {
        if (!started || isChatDraft) return;
        // The project moves with the pick; the empty draft left behind keeps none.
        if (leavingThreadId !== null && leavingThreadId !== started.threadId) {
          setPendingProjectFolder(leavingThreadId, null);
        }
        fileDraft(started.threadId);
      });
      return;
    }
    setLogicalProjectDraftThreadId(
      logicalProjectKey,
      scopeProjectRef(project.environmentId, project.id),
      draftId,
    );
    if (!isChatDraft && leavingThreadId !== null) fileDraft(leavingThreadId);
    if (!hasExplicitComposerModelSelection(currentDraft)) {
      applyStickyState(draftId);
      const environmentSettings = environments.find(
        (environment) => environment.environmentId === project.environmentId,
      )?.serverConfig?.settings;
      const defaultModelSelection = environmentSettings
        ? resolveProjectSettings(environmentSettings, project.id, project).settings
            .defaultModelSelection
        : project.defaultModelSelection;
      if (defaultModelSelection) {
        setModelSelection(draftId, defaultModelSelection, {
          replaceOptions: true,
        });
      }
    }
  };
  // Work without a repository, filed in `folder` (the Work project by default).
  const startScratch = async (
    folder: EnvironmentProjectLabel | null = workProject,
  ): Promise<boolean> => {
    if (scratchTargetEnvironmentId === null || isScratchDraft) {
      return false;
    }
    const requested = { draftId, activeProjectKey, scratchTargetEnvironmentId };
    const project = await openScratchProject(scratchTargetEnvironmentId);
    const latest = latestTargetRef.current;
    if (
      !project ||
      latest.draftId !== requested.draftId ||
      latest.activeProjectKey !== requested.activeProjectKey ||
      latest.scratchTargetEnvironmentId !== requested.scratchTargetEnvironmentId
    ) {
      return false;
    }
    selectProject(
      project,
      deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
      folder,
    );
    return true;
  };

  // A GitHub repository picked in the picker is cloned into its project; once
  // the clone lands it becomes the draft's repository, as long as the draft
  // still targets what it did when the clone started.
  const cloneStartedForRef = useRef<string | null>(null);
  const clonedRef = remoteClone.view?.phase === "done" ? remoteClone.ref : null;
  const clonedProject = remoteClone.active?.project ?? null;
  const clonedEntry = useMemo(() => {
    if (clonedRef === null) return null;
    const key = scopedProjectKey(clonedRef);
    for (const entry of projectEntryByKey.values()) {
      if (entry.group.memberProjectRefs.some((ref) => scopedProjectKey(ref) === key)) return entry;
    }
    return null;
  }, [clonedRef, projectEntryByKey]);
  useEffect(() => {
    if (clonedEntry === null || clonedProject === null) return;
    // Waits for the new repository to reach the project list.
    if (cloneStartedForRef.current === activeProjectKey) {
      if (clonedEntry.group.projectKey !== activeProjectKey) {
        selectProject(clonedEntry.targetProject, clonedEntry.group.projectKey, clonedProject);
      }
      setPickerOpen(false);
      setPickerQuery("");
    }
    cloneStartedForRef.current = null;
    remoteClone.release();
  });

  // A repository the project files on its own machine, which its row can take out.
  const canRemoveRepository = useCanRemoveRepositoryFromProject(workProject?.environmentId ?? null);
  const removeRepositoryFromProject = useRemoveRepositoryFromProject();
  const projectMemberOf = (entry: PickerEntry | undefined) => {
    if (!entry || workProject === null) return null;
    return (
      entry.group.memberProjects.find(
        (member) =>
          member.environmentId === workProject.environmentId &&
          workProject.label.repositoryIds.includes(member.id),
      ) ?? null
    );
  };
  const removeFromProject = (entry: PickerEntry) => {
    const member = projectMemberOf(entry);
    if (member === null || workProject === null) return;
    // The confirm takes over from the picker.
    setPickerOpen(false);
    setPickerQuery("");
    void removeRepositoryFromProject({
      project: workProject,
      repositoryId: member.id,
      title: entry.group.displayName,
    });
  };

  // The first action row carries the hairline that sets the actions apart.
  const filteredActionsLead =
    filteredPickerGroups.find((group) => group.value === ACTIONS_GROUP_KEY)?.items[0]?.value ??
    null;
  const actionsFollowRows = filteredPickerGroups.some(
    (group) => group.value !== ACTIONS_GROUP_KEY && group.items.length > 0,
  );
  const renderPickerItem = (item: PickerItem) => {
    const entry = projectEntryByKey.get(item.projectKey);
    const isAction = item.groupKey === ACTIONS_GROUP_KEY;
    return (
      <ComboboxItem
        key={item.value}
        hideIndicator
        value={item}
        tone={isAction ? "action" : "default"}
        divider={item.value === filteredActionsLead && actionsFollowRows}
      >
        {item.value === MANAGE_REPOSITORIES_VALUE ? (
          <ManageRepositoriesRowContent />
        ) : (
          <>
            <ComboboxItemIcon>
              {item.value === NO_REPOSITORY_VALUE ? (
                <ProjectFolderRowIcon />
              ) : item.value === ADD_PROJECT_VALUE ? (
                <FolderPlusIcon className="size-4" />
              ) : entry ? (
                <ProjectFavicon
                  project={entry.targetProject}
                  className="size-4"
                  fallback={<FolderGit2Icon className="size-4" />}
                />
              ) : null}
            </ComboboxItemIcon>
            <Tooltip>
              <TooltipTrigger render={<span className="min-w-0 flex-1 truncate text-sm" />}>
                {item.label}
              </TooltipTrigger>
              <TooltipPopup side="top">{item.label}</TooltipPopup>
            </Tooltip>
          </>
        )}
        {item.value === NO_REPOSITORY_VALUE && heroLine.projectFolderRow === "selected" ? (
          <CheckIcon className="ml-auto" />
        ) : null}
        {entry ? (
          <LocalRepositoryRowEnd
            identity={entry.targetProject.repositoryIdentity}
            removeLabel={`Remove ${entry.group.displayName} from ${workProject?.label.name ?? "the project"}`}
            {...(canRemoveRepository && projectMemberOf(entry) !== null
              ? { onRemove: () => removeFromProject(entry) }
              : {})}
          />
        ) : null}
      </ComboboxItem>
    );
  };

  const renderRemoteItem = (item: PickerItem) => {
    if (item.more !== undefined) {
      return <ShowMoreRemoteRow key={item.value} item={item} hidden={item.more} />;
    }
    const remote = item.remote;
    if (!remote) return null;
    return (
      <RemoteRepositoryRow
        key={item.value}
        item={item}
        repository={remote.repository}
        label={item.label}
        clone={remoteClone}
        view={remoteClone.isFor(remote) ? remoteClone.view : null}
      />
    );
  };

  const projectSelector = (
    <Combobox
      items={pickerGroups}
      filteredItems={filteredPickerGroups}
      autoHighlight
      itemToStringLabel={(item: PickerItem) => item.label}
      isItemEqualToValue={(a: PickerItem, b: PickerItem) => a.value === b.value}
      open={pickerOpen}
      onOpenChange={(open, details) => {
        // A GitHub result clones in place, with the picker still up.
        if (!open && details.reason === "item-press" && keepPickerOpenRef.current) {
          keepPickerOpenRef.current = false;
          return;
        }
        setPickerOpen(open);
        setPickerQuery("");
        if (!open) setShowAllRemote(false);
      }}
      value={selectedPickerItem}
      onValueChange={(item: PickerItem | null) => {
        if (!item) return;
        // "Show more" lists the rest of the GitHub results in place.
        if (item.more !== undefined) {
          keepPickerOpenRef.current = true;
          setShowAllRemote(true);
          return;
        }
        // A GitHub result clones into its project with the picker still up,
        // its row showing the progress; the repository is picked once it lands.
        if (item.remote) {
          keepPickerOpenRef.current = true;
          const target = item.remote;
          const view = remoteClone.isFor(target) ? remoteClone.view : null;
          if (view?.phase === "starting" || view?.phase === "running") return;
          if (view?.phase === "failed" || view?.phase === "cancelled") {
            void remoteClone.retry();
            return;
          }
          cloneStartedForRef.current = activeProjectKey;
          void remoteClone.start(target);
          return;
        }
        const addInto = workProject;
        setPickerOpen(false);
        if (item.value === NO_REPOSITORY_VALUE) {
          // Already there when the draft has no repository.
          void startScratch();
          return;
        }
        if (item.value === MANAGE_REPOSITORIES_VALUE) {
          if (addInto) {
            void navigate({
              to: "/settings/project-tags",
              search: {
                projectEnvironmentId: addInto.environmentId,
                projectLabelId: addInto.label.id,
              },
            });
          }
          return;
        }
        if (item.value === ADD_PROJECT_VALUE) {
          // With a project, the new repository goes into it.
          if (addInto) {
            openCommandPalette({
              open: "add-project",
              into: { environmentId: addInto.environmentId, labelId: addInto.label.id },
            });
          } else {
            openAddProject();
          }
          return;
        }
        // Only the project's own repositories are listed: the project stays.
        const entry = projectEntryByKey.get(item.projectKey);
        if (!entry || (item.projectKey === activeProjectKey && !isScratchDraft)) {
          return;
        }
        selectProject(entry.targetProject, entry.group.projectKey, workProject);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            // The trigger's accessible name comes from its visible text (the
            // project title) so the hero sentence reads naturally: an
            // aria-label here would replace the title with an action phrase
            // mid-sentence and baffle screen-reader users.
            // It shrinks (truncating) before the breadcrumb outgrows its line.
            <ComboboxTrigger
              render={
                <InlineButton
                  tone="picker"
                  className="pointer-events-auto min-w-0 max-w-64 shrink align-baseline"
                />
              }
              data-draft-project-trigger=""
            />
          }
        >
          {/* Plain inline flow, so the name shares the heading's baseline. The badge is an
              atomic inline box and stays clear of the button's underline. */}
          <span
            className={cn(
              "block truncate",
              breadcrumb.repository.placeholder && "text-muted-foreground",
            )}
          >
            {!breadcrumb.repository.placeholder && activeProjectDisplayName ? (
              activeProject ? (
                // Work's mark for a repository: its icon, else its initials badge.
                <ProjectFavicon
                  project={activeProject}
                  // Sized in em to the heading, like the hero's other inline icons.
                  className="inline-block size-[0.78em] align-[-0.06em] me-[0.28em]"
                  fallback={<RepositoryBadge name={activeProjectDisplayName} size="inline" />}
                />
              ) : (
                <RepositoryBadge name={activeProjectDisplayName} size="inline" />
              )
            ) : null}
            {breadcrumb.repository.text}
          </span>
        </TooltipTrigger>
        {!breadcrumb.repository.placeholder ? (
          <TooltipPopup side="top">{breadcrumb.repository.text}</TooltipPopup>
        ) : null}
      </Tooltip>
      {/* Clear of the heading's underline, so the popup starts under the sentence rather than on it. */}
      <ComboboxPopup align="center" sideOffset={8} className="w-72" animateHeight>
        <ComboboxSearchInput
          aria-label="Search repositories"
          placeholder="Search repositories…"
          value={pickerQuery}
          onChange={(event) => setPickerQuery(event.target.value)}
        />
        <ComboboxEmpty>{searchingGitHub ? null : "No matching repositories."}</ComboboxEmpty>
        <ComboboxList>
          {(group: PickerGroup) => (
            <ComboboxGroup
              key={group.value}
              items={group.items}
              // The footer's divider spaces it; no group gap on top of that.
              className={group.value === ACTIONS_GROUP_KEY ? "not-first:mt-0" : undefined}
            >
              {group.remote ? (
                <RemoteRepositorySection
                  state={group.remote.state}
                  owners={linkedGitHubOwners(group.remote.project)}
                  renderItem={renderRemoteItem}
                />
              ) : (
                // One flat list: the no-repository row, the project's
                // repositories, then the footer actions.
                <>
                  {group.label ? (
                    <RepositorySourceLabel
                      icon={
                        <EnvironmentMachineIcon
                          aria-hidden
                          kind={
                            (group.environmentId
                              ? environmentMachineById.get(group.environmentId)
                              : undefined) ?? resolveEnvironmentMachineKind(null)
                          }
                          className="size-3"
                        />
                      }
                      label={group.label}
                    />
                  ) : null}
                  <ComboboxGroupItems afterHeader={group.label !== null}>
                    <ComboboxCollection>
                      {(item: PickerItem) => renderPickerItem(item)}
                    </ComboboxCollection>
                  </ComboboxGroupItems>
                </>
              )}
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );

  // The composer hero is a sentence, so the heading's accessible name must be
  // a complete sentence too. The project picker is a control rendered inline
  // in the h1; without an explicit label its widget state bleeds into the
  // announced phrase.
  // Fixed when the screen opens, so the line holds still while the user types.
  const [greeting] = useState(() => chatGreeting(new Date()));
  // A chat picked into a project says so after the greeting, quietly.
  const greetingSuffix = heroProjectSuffix(pendingProject?.label.name ?? null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  // Work's project and repository change in place: its pieces glide and the
  // changed name crossfades (useHeroHeadlineMotion), also across the new draft
  // a picked repository opens.
  const workHeroKey = `${workProjectKey ?? "none"}:${isScratchDraft ? "none" : activeProjectKey}`;
  useHeroHeadlineMotion(
    headingRef,
    measureRef,
    isChatDraft && draftThread ? `chat:${draftThread.threadId}` : "heading",
    { contentKey: isChatDraft ? "chat" : workHeroKey, handoff: DRAFT_HEADING_GROUP },
  );
  // A project picked for this Work draft, in the hero or the toolbar, moves it
  // to one of the project's repositories: the current one if the project holds
  // it, else its most recently active. "No project" does the same among the
  // repositories in no project. With none to pick, Work runs without a
  // repository (in the project's folder) and is filed in the project.
  const noProjectPicked = useWorkNoProjectPicked(draftThread?.threadId);
  useEffect(() => {
    if (!draftThread) return;
    const choseProject = pendingFolder?.chosen === true && pendingProject !== null;
    if (!choseProject && !noProjectPicked) return;
    // A project picked after "No project" wins.
    if (noProjectPicked) answerNoProjectPick(draftThread.threadId);
    if (choseProject && pendingFolder) {
      setPendingProjectFolder(draftThread.threadId, {
        environmentId: pendingFolder.environmentId,
        folderId: pendingFolder.folderId,
      });
    }
    if (isChatDraft) return;
    const project = choseProject ? pendingProject : null;
    const lastActive = new Map<string, number>();
    for (const thread of threads) {
      if (thread.archivedAt !== null) continue;
      const key = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      const at = Date.parse(thread.updatedAt);
      if (at > (lastActive.get(key) ?? Number.NEGATIVE_INFINITY)) lastActive.set(key, at);
    }
    const target = projectDefaultRepository({
      items: repositoryItems,
      refsOf: refsOfRepository,
      project,
      projects: projectDirectory.active,
      isCurrent: (item) => !isScratchDraft && item.projectKey === activeProjectKey,
      lastActiveAt: (item) =>
        Math.max(
          Number.NEGATIVE_INFINITY,
          ...refsOfRepository(item).map(
            (ref) => lastActive.get(scopedProjectKey(ref)) ?? Number.NEGATIVE_INFINITY,
          ),
        ),
    });
    const entry = target ? projectEntryByKey.get(target.projectKey) : undefined;
    if (entry) {
      if (isScratchDraft || target?.projectKey !== activeProjectKey) {
        selectProject(entry.targetProject, entry.group.projectKey, project);
        return;
      }
      // Staying put: Work already follows its repository's own project.
      if (project !== null && activeProject !== null) {
        const folderId = workDraftFolderId({
          repository: { environmentId: activeProject.environmentId, projectId: activeProject.id },
          project,
          folderByRepository: projectDirectory.folderByRepository,
        });
        if (folderId === null) setPendingProjectFolder(draftThread.threadId, null);
      }
      return;
    }
    // Nothing to run in: Work goes without a repository, filed in the project.
    if (!isScratchDraft) void startScratch(project);
  });
  const projectHeadline =
    draftThread && draftId ? (
      <ComposerProjectPicker
        appearance="headline"
        environmentId={draftThread.environmentId}
        threadId={draftThread.threadId}
        draftId={draftId}
        size="sm"
      />
    ) : (
      <WorkHeroCrumbText crumb={breadcrumb.project} />
    );
  const headingLabel = isChatDraft ? `${greeting}${greetingSuffix ?? ""}` : breadcrumb.label;

  return (
    <div className="@container mx-auto flex w-full max-w-5xl flex-col items-center">
      {/* Sized to the pane, not the window: beside an open right panel the
          greeting steps down so it and its project stay on one line. A step
          rescales smoothly, and a project or breadcrumb that no longer fits
          goes to its own line (useHeroHeadlineMotion). */}
      <h1
        ref={headingRef}
        aria-label={headingLabel}
        className="group/hero-headline relative w-full origin-bottom text-balance text-center font-normal text-xl text-foreground tracking-tight @xl:text-2xl @2xl:text-3xl"
      >
        {/* The greeting and its project on one line, to tell whether they fit. */}
        <span
          ref={measureRef}
          aria-hidden
          className="pointer-events-none invisible absolute start-0 top-0 whitespace-pre"
        />
        <FadeSwap
          group={DRAFT_HEADING_GROUP}
          // A chat's project and Work's breadcrumb change in place, not by a swap.
          swapKey={isChatDraft ? "chat" : "work"}
        >
          {isChatDraft ? (
            <>
              <span
                data-hero-greeting=""
                className="inline-block max-w-full group-data-stacked/hero-headline:block"
              >
                {greeting}
              </span>
              {draftThread && draftId ? (
                <ComposerProjectPicker
                  appearance="hero"
                  environmentId={draftThread.environmentId}
                  threadId={draftThread.threadId}
                  draftId={draftId}
                  size="sm"
                />
              ) : null}
            </>
          ) : (
            // Project, then the repository within it: each half is its own
            // picker, so either can be swapped on its own.
            <WorkHeroSentence project={projectHeadline} repository={projectSelector} />
          )}
        </FadeSwap>
      </h1>
    </div>
  );
}

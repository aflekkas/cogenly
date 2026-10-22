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
import { FolderGit2Icon, FolderIcon, FolderPlusIcon, LockIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
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
  projectGroupsSpanEnvironments,
} from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import {
  setPendingProjectFolder,
  usePendingProjectFolderStore,
} from "~/projectLabels/pendingProjectFolders";
import {
  projectLabelKey,
  scopedRepositoryKey,
  type EnvironmentProjectLabel,
  type ProjectLabelKey,
} from "~/projectLabels/projectLabels.logic";
import {
  groupRepositoriesByProject,
  heroProjectSuffix,
  isRepositoryGroupOpen,
  OTHER_REPOSITORIES_GROUP_KEY,
  projectDefaultRepository,
  toggleCollapsedGroup,
  workDraftFolderId,
} from "~/projectLabels/projectMeta.logic";
import { ComposerProjectPicker } from "~/projectLabels/ComposerProjectPicker";
import { HERO_INLINE_ICON_STYLE, ProjectFolderIcon } from "~/projectLabels/ProjectFolderMark";
import {
  linkedGitHubOwners,
  mergeRemoteRepositorySections,
  type OwnerSearchState,
} from "~/projectLabels/projectSourceLinks.logic";
import { useOwnerRepositorySearch } from "~/projectLabels/useOwnerRepositorySearch";
import {
  type RemoteCloneView,
  useRemoteRepositoryClone,
} from "~/projectLabels/useRemoteRepositoryClone";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import * as Schema from "effect/Schema";
import { useProjectLabelDirectory } from "~/projectLabels/useProjectLabels";
import { chatGreeting } from "./chatGreeting";
import { FadeSwap } from "./StateTransition";
import { useHeroHeadlineMotion } from "./useHeroHeadlineMotion";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupCollapse,
  ComboboxGroupItems,
  ComboboxGroupLabel,
  ComboboxGroupToggle,
  ComboboxItem,
  ComboboxItemIcon,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button, InlineButton } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { GitHubIcon } from "../Icons";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

// Picker values for the action rows; repositories are keyed by their group
// and logical project key, since one can show under several projects.
const ADD_PROJECT_VALUE = "add-project";
const ACTIONS_GROUP_KEY = "actions";
const COLLAPSED_GROUPS_STORAGE_KEY = "cogenly:repository-picker:collapsed-projects";
const CollapsedGroupKeys = Schema.mutable(Schema.Array(Schema.String));
const EMPTY_GROUP_KEYS: string[] = [];

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
}

interface PickerGroup {
  readonly value: string;
  /** The header; null on a list with no projects, and on the actions. */
  readonly label: string | null;
  readonly color: string | undefined;
  readonly isProject: boolean;
  readonly items: readonly PickerItem[];
  /** Set on a project's "On GitHub" section, which follows the project's own group. */
  readonly remote?: {
    readonly project: EnvironmentProjectLabel;
    readonly state: OwnerSearchState;
  };
  /** Whether an "On GitHub" section follows this group, which keeps it open while searching. */
  readonly remoteFollows?: boolean;
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
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

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
  // Same-named projects on two machines are only told apart by where they
  // live, so rows on another machine carry its icon once the catalog spans
  // more than one environment; a single-machine catalog stays as it was.
  const showProjectEnvironments = useMemo(
    () => projectGroupsSpanEnvironments(projectGroups),
    [projectGroups],
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
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projectPickerEntries.length > 0;
  const shouldShowProjectMenu = canChooseProject;
  // Whether a project is its machine's no-project home. Read from the
  // machine's config even while it reconnects: scratchWorkspaceRootFor is
  // null then, and the home would read as a project named "No project".
  const isNoProjectHome = useCallback(
    (project: { readonly environmentId: EnvironmentId; readonly workspaceRoot: string }) =>
      isScratchProject(
        project,
        scratchWorkspaceRootFor(project.environmentId) ??
          environments.find((environment) => environment.environmentId === project.environmentId)
            ?.serverConfig?.scratchWorkspaceRoot,
      ),
    [environments, scratchWorkspaceRootFor],
  );
  // The project that hosts threads without a project is not a row: the line
  // under the headline is the way into it.
  const menuEntries = useMemo(
    () => projectPickerEntries.filter(({ targetProject }) => !isNoProjectHome(targetProject)),
    [isNoProjectHome, projectPickerEntries],
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

  // Repositories are grouped under the projects (folders) that hold them,
  // "Other repositories" last. Folders live per environment; every connected
  // one contributes.
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
  const buildPickerGroups = useCallback(
    (
      items: readonly PickerItem[],
      leadProject: ProjectLabelKey | null,
      withActions: boolean,
      remote: ReadonlyMap<ProjectLabelKey, OwnerSearchState> | null = null,
    ) => {
      const grouped = groupRepositoriesByProject({
        items,
        refsOf: refsOfRepository,
        projects: projectDirectory.labels,
        leadProject,
      });
      const sections =
        remote === null || remote.size === 0
          ? grouped.map((group) => ({ kind: "local" as const, group }))
          : mergeRemoteRepositorySections({
              groups: grouped,
              projects: projectDirectory.labels,
              remoteOf: (key) => remote.get(key),
            });
      // Without any project there is nothing to group by: one plain list.
      const titled = sections.some(
        (section) => section.kind === "remote" || section.group.project !== null,
      );
      const groups: PickerGroup[] = sections.map((section, index) => {
        if (section.kind === "remote") {
          const groupKey = `remote:${section.project.key}`;
          return {
            value: groupKey,
            label: "On GitHub",
            color: undefined,
            isProject: false,
            remote: { project: section.project, state: section.state },
            items: section.repositories.map((repository) => ({
              value: `${groupKey}|${repository.nameWithOwner}`,
              label: repository.name,
              projectKey: "",
              groupKey,
              remote: { project: section.project, repository },
            })),
          };
        }
        const { group } = section;
        return {
          value: group.key,
          label: titled ? (group.project?.label.name ?? "Other repositories") : null,
          color: group.project?.label.color,
          isProject: group.project !== null,
          remoteFollows: sections[index + 1]?.kind === "remote",
          items: group.items.map((item) => ({
            ...item,
            value: `${group.key}|${item.projectKey}`,
            groupKey: group.key,
          })),
        };
      });
      if (withActions) {
        groups.push({
          value: ACTIONS_GROUP_KEY,
          label: null,
          color: undefined,
          isProject: false,
          items: [
            {
              value: ADD_PROJECT_VALUE,
              label: "Add repository",
              projectKey: "",
              groupKey: ACTIONS_GROUP_KEY,
            },
          ],
        });
      }
      return groups;
    },
    [projectDirectory.labels, refsOfRepository],
  );
  const pickerGroups = useMemo(
    () => buildPickerGroups(repositoryItems, workProjectKey, true),
    [buildPickerGroups, repositoryItems, workProjectKey],
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const keepPickerOpenRef = useRef(false);
  // Project groups the user collapsed, kept per device.
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useLocalStorage(
    COLLAPSED_GROUPS_STORAGE_KEY,
    EMPTY_GROUP_KEYS,
    CollapsedGroupKeys,
  );
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerFilter = useComboboxFilter();
  // A search also asks GitHub, under each project linked to an owner.
  const ownerSearch = useOwnerRepositorySearch(
    projectDirectory.labels,
    pickerOpen ? pickerQuery : "",
  );
  // The project's own repositories lead, searching or not.
  const filteredPickerGroups = useMemo(() => {
    const query = pickerQuery.trim();
    if (query.length === 0) return pickerGroups;
    return buildPickerGroups(
      repositoryItems.filter((item) =>
        pickerFilter.contains(item, query, (candidate) => candidate.label),
      ),
      workProjectKey,
      false,
      ownerSearch,
    );
  }, [
    buildPickerGroups,
    ownerSearch,
    pickerFilter,
    pickerGroups,
    pickerQuery,
    repositoryItems,
    workProjectKey,
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
  const selectedPickerItem =
    pickerGroups
      .find((group) => group.value === (repositoryFolder?.key ?? OTHER_REPOSITORIES_GROUP_KEY))
      ?.items.find((item) => item.projectKey === activeProjectKey) ??
    pickerGroups
      .flatMap((group) => group.items)
      .find((item) => item.projectKey === activeProjectKey) ??
    null;

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
  const startScratch = async (): Promise<boolean> => {
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
      workProject,
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
    remoteClone.dismiss();
  });

  // The first action row carries the hairline that sets the actions apart.
  const filteredActionsLead =
    filteredPickerGroups.find((group) => group.value === ACTIONS_GROUP_KEY)?.items[0]?.value ??
    null;
  const renderPickerItem = (item: PickerItem) => {
    const entry = projectEntryByKey.get(item.projectKey);
    const isAction = item.groupKey === ACTIONS_GROUP_KEY;
    return (
      <ComboboxItem
        key={item.value}
        hideIndicator
        value={item}
        tone={isAction ? "action" : "default"}
        divider={item.value === filteredActionsLead && menuEntries.length > 0}
      >
        <ComboboxItemIcon>
          {item.value === ADD_PROJECT_VALUE ? (
            <FolderPlusIcon className="size-4" />
          ) : entry ? (
            <FolderGit2Icon className="size-4" />
          ) : null}
        </ComboboxItemIcon>
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 flex-1 truncate text-sm" />}>
            {item.label}
          </TooltipTrigger>
          <TooltipPopup side="top">{item.label}</TooltipPopup>
        </Tooltip>
        {entry && showProjectEnvironments ? (
          <ProjectEnvironmentBadge
            group={entry.group}
            primaryEnvironmentId={primaryEnvironmentId}
            machineByEnvironmentId={environmentMachineById}
          />
        ) : null}
      </ComboboxItem>
    );
  };

  const renderRemoteItem = (item: PickerItem) => {
    const remote = item.remote;
    if (!remote) return null;
    const { repository } = remote;
    const clone = remoteClone.isFor(remote) ? remoteClone.view : null;
    const busy = clone?.phase === "starting" || clone?.phase === "running";
    return (
      <Fragment key={item.value}>
        <ComboboxItem hideIndicator value={item}>
          <ComboboxItemIcon>
            {busy ? <Spinner size="xs" tone="muted" /> : <FolderGit2Icon className="size-4" />}
          </ComboboxItemIcon>
          <span className="min-w-0 shrink truncate text-sm">{repository.name}</span>
          {repository.private ? (
            <LockIcon aria-label="Private" className="size-3 shrink-0" />
          ) : null}
          {repository.description ? (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {repository.description}
            </span>
          ) : null}
        </ComboboxItem>
        {clone ? (
          <RemoteCloneStatus
            key={clone.phase}
            view={clone}
            onCancel={() => void remoteClone.cancel()}
            onRetry={() => void remoteClone.retry()}
            onRemove={() => void remoteClone.remove()}
          />
        ) : null}
      </Fragment>
    );
  };

  const projectSelector = shouldShowProjectMenu ? (
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
      }}
      value={selectedPickerItem}
      onValueChange={(item: PickerItem | null) => {
        if (!item) return;
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
        // A repository in a project brings its project; one in none keeps the
        // draft's, so Work about it is still filed there.
        const folder =
          item.groupKey === OTHER_REPOSITORIES_GROUP_KEY
            ? workProject
            : (projectDirectory.byKey.get(item.groupKey as ProjectLabelKey) ?? null);
        const entry = projectEntryByKey.get(item.projectKey);
        if (!entry || item.projectKey === activeProjectKey) {
          return;
        }
        selectProject(entry.targetProject, entry.group.projectKey, folder);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            // The trigger's accessible name comes from its visible text (the
            // project title) so the hero sentence reads naturally: an
            // aria-label here would replace the title with an action phrase
            // mid-sentence and baffle screen-reader users.
            <ComboboxTrigger
              render={<InlineButton tone={isScratchDraft ? "muted" : "picker"} />}
              data-draft-project-trigger=""
              className="pointer-events-auto max-w-64 align-baseline"
            />
          }
        >
          {/* Plain inline flow, so the name shares the heading's baseline. The badge is an
              atomic inline box and stays clear of the button's underline. */}
          <span className="block">
            {!isScratchDraft && activeProjectDisplayName ? (
              <FolderGit2Icon
                aria-hidden
                className="inline-block text-muted-foreground"
                style={HERO_INLINE_ICON_STYLE}
              />
            ) : null}
            {isScratchDraft
              ? "in a repository…"
              : (activeProjectDisplayName ?? "Choose a repository")}
          </span>
        </TooltipTrigger>
        {activeProjectDisplayName && !isScratchDraft ? (
          <TooltipPopup side="top">{activeProjectDisplayName}</TooltipPopup>
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
                  group={group}
                  state={group.remote.state}
                  owners={linkedGitHubOwners(group.remote.project)}
                  renderItem={renderRemoteItem}
                />
              ) : group.label !== null ? (
                <RepositoryPickerGroupBody
                  group={group}
                  open={isRepositoryGroupOpen({
                    groupKey: group.value,
                    collapsedKeys: collapsedGroupKeys,
                    searching: pickerQuery.trim().length > 0,
                    hasMatches: group.items.length > 0 || group.remoteFollows === true,
                  })}
                  onToggle={() =>
                    setCollapsedGroupKeys((keys) => toggleCollapsedGroup(keys, group.value))
                  }
                  renderItem={renderPickerItem}
                />
              ) : (
                // Flat lists and the footer actions; with project groups
                // above, the footer lines up with their tucked-in rows.
                <ComboboxGroupItems
                  inset={
                    group.value === ACTIONS_GROUP_KEY &&
                    filteredPickerGroups.some((entry) => entry.label !== null)
                  }
                >
                  <ComboboxCollection>
                    {(item: PickerItem) => renderPickerItem(item)}
                  </ComboboxCollection>
                </ComboboxGroupItems>
              )}
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  ) : (
    <button
      type="button"
      onClick={openAddProject}
      className="pointer-events-auto inline cursor-pointer text-muted-foreground/60 underline decoration-muted-foreground/35 underline-offset-4 transition-colors hover:text-muted-foreground/80 hover:decoration-muted-foreground/60 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {activeProjectTitle ?? "Add a repository"}
    </button>
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
  useHeroHeadlineMotion(
    headingRef,
    measureRef,
    isChatDraft && draftThread ? `chat:${draftThread.threadId}` : "heading",
  );
  // A project picked for this Work draft, in the hero or the toolbar, moves it
  // to one of the project's repositories: the current one if the project holds
  // it, else its most recently active. A project with none, or a draft started
  // without a repository, keeps where the Work runs and is filed in the project.
  useEffect(() => {
    if (!draftThread || pendingFolder?.chosen !== true || pendingProject === null) return;
    const answered = {
      environmentId: pendingFolder.environmentId,
      folderId: pendingFolder.folderId,
    };
    setPendingProjectFolder(draftThread.threadId, answered);
    if (isChatDraft || isScratchDraft) return;
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
      project: pendingProject,
      isCurrent: (item) => item.projectKey === activeProjectKey,
      lastActiveAt: (item) =>
        Math.max(
          Number.NEGATIVE_INFINITY,
          ...refsOfRepository(item).map(
            (ref) => lastActive.get(scopedProjectKey(ref)) ?? Number.NEGATIVE_INFINITY,
          ),
        ),
    });
    const entry = target ? projectEntryByKey.get(target.projectKey) : undefined;
    if (entry && target?.projectKey !== activeProjectKey) {
      selectProject(entry.targetProject, entry.group.projectKey, pendingProject);
      return;
    }
    // Staying put: Work already follows its repository's own project.
    if (activeProject !== null) {
      const folderId = workDraftFolderId({
        repository: { environmentId: activeProject.environmentId, projectId: activeProject.id },
        project: pendingProject,
        folderByRepository: projectDirectory.folderByRepository,
      });
      if (folderId === null) setPendingProjectFolder(draftThread.threadId, null);
    }
  });
  const projectHeadline =
    workProject && draftThread && draftId ? (
      <ComposerProjectPicker
        appearance="headline"
        environmentId={draftThread.environmentId}
        threadId={draftThread.threadId}
        draftId={draftId}
        size="sm"
      />
    ) : null;
  const headingLabel = isChatDraft
    ? `${greeting}${greetingSuffix ?? ""}`
    : workProject
      ? `What should we build in ${workProject.label.name}?`
      : isScratchDraft
        ? "What should we build?"
        : hasResolvedProject
          ? `What should we build in ${activeProjectDisplayName}?`
          : canChooseProject
            ? `${activeProjectDisplayName ?? "Choose a repository"} to start`
            : "Add a repository to start";

  // One click out of the project, phrased as the alternative to the question
  // above it. Focus moves to the project picker once this line has gone.
  const noProjectShortcut = shortcutLabelForCommand(keybindings, "chat.newWithoutProject");
  const orStartWithoutProject =
    scratchWorkspaceRoot !== null && !isScratchDraft && (hasResolvedProject || canChooseProject) ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              tone="muted"
              className="pointer-events-auto"
              onClick={() =>
                void startScratch().then((started) => {
                  if (started) {
                    document.querySelector<HTMLElement>("[data-draft-project-trigger]")?.focus();
                  }
                })
              }
            />
          }
        >
          or start without a repository
        </TooltipTrigger>
        {noProjectShortcut ? <TooltipPopup side="bottom">{noProjectShortcut}</TooltipPopup> : null}
      </Tooltip>
    ) : null;

  return (
    <div className="@container mx-auto flex w-full max-w-5xl flex-col items-center">
      {/* Sized to the pane, not the window: beside an open right panel the
          greeting steps down so it and its project stay on one line. A step
          rescales smoothly, and a project that no longer fits goes to its own
          line (useHeroHeadlineMotion). */}
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
          group="draft-heading"
          swapKey={
            // A chat's project changes in place (the tail glides), not by a swap.
            isChatDraft
              ? "chat"
              : workProject
                ? `project:${workProject.key}`
                : isScratchDraft
                  ? "no-repository"
                  : `repository:${activeProjectKey}`
          }
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
          ) : projectHeadline ? (
            <>What should we build in {projectHeadline}?</>
          ) : isScratchDraft ? (
            <>What should we build?</>
          ) : hasResolvedProject ? (
            <>What should we build in {projectSelector}?</>
          ) : canChooseProject ? (
            <>{projectSelector} to start</>
          ) : (
            <>Add a repository to start</>
          )}
        </FadeSwap>
      </h1>
      {/* Reserved whenever threads can skip a project, so the heading does not
          move. Without a project, the picker moves here to choose one. */}
      {isChatDraft ||
      (projectHeadline === null && scratchWorkspaceRoot === null && !isScratchDraft) ? null : (
        <p className="mt-2 flex h-6 items-center text-sm">
          <FadeSwap
            group="draft-subline"
            swapKey={
              projectHeadline && !isScratchDraft
                ? "project-repository"
                : isScratchDraft
                  ? "picker"
                  : "start-without"
            }
          >
            {projectHeadline && !isScratchDraft ? (
              // In a project, the repository is the second choice, picked within it.
              <span className="text-muted-foreground">
                in {projectSelector}
                {orStartWithoutProject ? <> · {orStartWithoutProject}</> : null}
              </span>
            ) : isScratchDraft ? (
              projectSelector
            ) : (
              orStartWithoutProject
            )}
          </FadeSwap>
        </p>
      )}
    </div>
  );
}

/**
 * A titled group of the repository picker: its project's folder in color (a
 * plain folder for "Other repositories"), collapsible from the header.
 */
function RepositoryPickerGroupBody(props: {
  readonly group: PickerGroup;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly renderItem: (item: PickerItem) => ReactNode;
}) {
  const { group } = props;
  return (
    <>
      <ComboboxGroupToggle
        open={props.open}
        onClick={props.onToggle}
        icon={
          group.isProject ? (
            <ProjectFolderIcon color={group.color} className="size-3.5" />
          ) : (
            <FolderIcon aria-hidden className="size-3.5" />
          )
        }
      >
        {group.label}
      </ComboboxGroupToggle>
      <ComboboxGroupCollapse open={props.open}>
        <ComboboxCollection>{(item: PickerItem) => props.renderItem(item)}</ComboboxCollection>
      </ComboboxGroupCollapse>
    </>
  );
}

/**
 * A project's GitHub results under its own repositories: a quiet "On GitHub"
 * line, then the repositories not on this machine yet. A slow search shows
 * one spinner row; a failed one a single muted line.
 */
function RemoteRepositorySection(props: {
  readonly group: PickerGroup;
  readonly state: OwnerSearchState;
  readonly owners: ReadonlyArray<string>;
  readonly renderItem: (item: PickerItem) => ReactNode;
}) {
  const { state } = props;
  const ownerName = props.owners.length === 1 ? props.owners[0] : "linked owners";
  return (
    <div className="reveal-motion">
      <ComboboxGroupLabel>
        <span className="flex size-4 shrink-0 items-center justify-center">
          <GitHubIcon aria-hidden className="size-3" />
        </span>
        <span className="min-w-0 flex-1 truncate">On GitHub</span>
      </ComboboxGroupLabel>
      {state.status === "loading" ? (
        <div className="reveal-motion flex h-7 items-center gap-2 px-2 text-xs text-muted-foreground">
          <span className="flex size-4 shrink-0 items-center justify-center">
            <Spinner size="xs" tone="muted" />
          </span>
          <span className="min-w-0 truncate">Searching {ownerName}…</span>
        </div>
      ) : state.status === "error" ? (
        <p className="reveal-motion truncate py-1 ps-8 pe-2 text-xs text-muted-foreground">
          {state.message}
        </p>
      ) : null}
      <ComboboxGroupItems afterHeader>
        <ComboboxCollection>{(item: PickerItem) => props.renderItem(item)}</ComboboxCollection>
      </ComboboxGroupItems>
    </div>
  );
}

/** The clone of a picked GitHub repository, under its row: progress, then the way on. */
function RemoteCloneStatus(props: {
  readonly view: RemoteCloneView;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onRemove: () => void;
}) {
  const { view } = props;
  if (view.phase === "done") return null;
  const text =
    view.phase === "starting"
      ? "Starting clone…"
      : view.phase === "running"
        ? view.summary
        : view.phase === "cancelled"
          ? "Clone cancelled"
          : view.message;
  return (
    <div
      role="status"
      className="reveal-motion flex min-h-7 items-center gap-2 ps-8 pe-1 text-xs text-muted-foreground"
    >
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {view.phase === "running" ? (
        <Button size="xs" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      ) : view.phase === "failed" || view.phase === "cancelled" ? (
        <>
          {view.phase === "cancelled" || view.canRemove ? (
            <Button size="xs" variant="ghost" onClick={props.onRemove}>
              Remove
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" onClick={props.onRetry}>
            Retry
          </Button>
        </>
      ) : null}
    </div>
  );
}

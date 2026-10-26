import type { DraftId } from "~/composerDraftStore";
import {
  composerDraftHasUserContent,
  surfaceDraftKey,
  useComposerDraftStore,
} from "~/composerDraftStore";
import {
  type EnvironmentId,
  type ScopedProjectRef,
  type ThreadId,
  type ThreadSurface,
} from "@cogenly/contracts";
import { scopedProjectKey, scopeProjectRef } from "@cogenly/client-runtime/environment";
import { isScratchProject } from "@cogenly/client-runtime/state/projects";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  draftWorkProject,
  heroProjectSuffix,
  isPickableRepository,
  projectDefaultRepository,
  projectHoldsRepository,
  projectDroppedNote,
  projectSwitchRepository,
  workDraftFolderId,
  workHeroBreadcrumb,
  workHeroLine,
} from "~/projectLabels/projectMeta.logic";
import { ComposerProjectPicker } from "~/projectLabels/ComposerProjectPicker";
import {
  ManageRepositoriesRowContent,
  PickerRowContent,
  ProjectFolderRowIcon,
  RepositoryRowIcon,
} from "~/projectLabels/RepositorySourceRows";
import { linkedRepositoryIcon } from "~/projectLabels/repositoryPicker.logic";
import {
  RepositoryPickerGroupContent,
  useRepositoryPicker,
  type RepositoryPickerGroup,
  type RepositoryPickerItem,
} from "~/projectLabels/useRepositoryPicker";
import { useProjectLabelDirectory } from "~/projectLabels/useProjectLabels";
import { useRepositoryNames } from "~/projectLabels/useRepositoryNames";
import { answerNoProjectPick, useWorkNoProjectPicked } from "~/projectLabels/workNoProjectPicks";
import { useChatGreeting } from "./useChatGreeting";
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
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InlineButton } from "../ui/button";

/** The draft heading's FadeSwap slot, which a replacing draft's heading picks up from. */
const DRAFT_HEADING_GROUP = "draft-heading";
const MANAGE_REPOSITORIES_VALUE = "manage-repositories";
// Work without a repository (in the project's folder): the row that leads the picker.
const NO_REPOSITORY_VALUE = "no-repository";
const NO_REPOSITORY_GROUP_KEY = "no-repository";

/** A logical project's repository, for the default-repository pick a project choice makes. */
interface RepositoryChoice {
  readonly value: string;
  readonly label: string;
  /** The logical project key. */
  readonly projectKey: string;
}

/** The hero's own rows around the shared repository list. */
type HeroRow =
  | { readonly kind: "no-repository"; readonly value: string; readonly label: string }
  | { readonly kind: "manage"; readonly value: string; readonly label: string };
type PickerItem = RepositoryPickerItem | HeroRow;

interface PickerGroup {
  readonly value: string;
  readonly items: readonly PickerItem[];
  /** Set on the shared list's groups, which render themselves. */
  readonly shared?: RepositoryPickerGroup;
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

  // Folders live per environment; every connected one contributes.
  const environmentIds = useMemo(
    () => environments.map((environment) => environment.environmentId),
    [environments],
  );
  const projectDirectory = useProjectLabelDirectory(environmentIds);
  const repositoryNameOf = useRepositoryNames();
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
  const activeRepositoryRef = activeProjectRef === null || isScratchDraft ? null : activeProjectRef;
  const repositoryFolder =
    activeRepositoryRef === null
      ? null
      : (projectDirectory.folderByRepository.get(
          scopedRepositoryKey(activeRepositoryRef.environmentId, activeRepositoryRef.projectId),
        ) ?? null);
  // Work's project: the one picked for the draft, else its repository's own,
  // which Work follows. It leads the sentence; the repository is picked in it.
  // A pick that does not hold the repository is stale, and corrected below.
  const draftProject = draftWorkProject({
    pending: pendingProject,
    pendingRepositoryId: pendingFolder?.repositoryId,
    repository: activeRepositoryRef,
    folderByRepository: projectDirectory.folderByRepository,
  });
  const workProject = isChatDraft ? null : draftProject.project;
  const heroLine = workHeroLine({
    isChat: isChatDraft,
    hasProject: workProject !== null,
    hasRepository: !isScratchDraft,
    canStartWithoutRepository: scratchWorkspaceRoot !== null,
  });
  const showProjectFolderRow = heroLine.projectFolderRow !== "hidden";
  // What a project pick moves the draft to: the logical projects' repositories.
  const repositoryItems = useMemo(
    (): RepositoryChoice[] =>
      menuEntries.map(({ group }) => ({
        value: group.projectKey,
        label: group.displayName,
        projectKey: group.projectKey,
      })),
    [menuEntries],
  );
  const refsOfRepository = useCallback(
    (item: RepositoryChoice) =>
      projectEntryByKey.get(item.projectKey)?.group.memberProjectRefs ?? [],
    [projectEntryByKey],
  );
  const projectFolderRowLabel = heroLine.projectFolderRowLabel;
  const [pickerOpen, setPickerOpen] = useState(false);
  const keepPickerOpenRef = useRef(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerFilter = useComboboxFilter();
  const closePicker = useCallback(() => {
    setPickerOpen(false);
    setPickerQuery("");
  }, []);
  // The repositories on the draft's machine (the composer's "Run on"): the
  // Work project's, every one it links with its state there, or with no
  // project the machine's own. Picking one keeps the project.
  const pickerEnvironmentId =
    draftThread?.environmentId ?? activeProjectRef?.environmentId ?? primaryEnvironmentId;
  const pickRepositoryRef = useRef<(repository: (typeof projects)[number]) => void>(() => {});
  const repositoryPicker = useRepositoryPicker({
    environmentId: pickerEnvironmentId,
    project: workProject,
    open: pickerOpen,
    query: pickerQuery,
    leadRepositoryId: isScratchDraft ? null : (activeProject?.id ?? null),
    onPick: (repository) => pickRepositoryRef.current(repository),
    onClose: closePicker,
  });
  const selectedRow = isScratchDraft
    ? null
    : (repositoryPicker.rows.find(
        (row) =>
          row.local !== null &&
          row.local.environmentId === activeProjectRef?.environmentId &&
          row.local.id === activeProjectRef.projectId,
      ) ?? null);
  // The repository reads as its picker row does, also before the row lists.
  const breadcrumb = workHeroBreadcrumb({
    projectName: workProject?.label.name ?? null,
    repositoryName:
      selectedRow?.name ??
      (activeProject ? repositoryNameOf(activeProject) : activeProjectDisplayName),
    hasRepository: !isScratchDraft,
  });
  const noRepositoryItem = useMemo(
    (): HeroRow => ({
      kind: "no-repository",
      value: NO_REPOSITORY_VALUE,
      label: projectFolderRowLabel,
    }),
    [projectFolderRowLabel],
  );
  const listing = repositoryPicker.mode === "list";
  const query = pickerQuery.trim();
  const pickerGroups = useMemo((): PickerGroup[] => {
    const showNoRepository =
      showProjectFolderRow &&
      listing &&
      (query.length === 0 ||
        pickerFilter.contains(projectFolderRowLabel, query, (candidate) => candidate));
    return [
      ...(showNoRepository ? [{ value: NO_REPOSITORY_GROUP_KEY, items: [noRepositoryItem] }] : []),
      ...repositoryPicker.groups.map((group) => ({
        value: group.value,
        items: group.items,
        shared: group,
      })),
      // The project's page in Settings lists, removes and adds its repositories.
      ...(listing && workProject !== null && query.length === 0
        ? [
            {
              value: MANAGE_REPOSITORIES_VALUE,
              items: [
                {
                  kind: "manage" as const,
                  value: MANAGE_REPOSITORIES_VALUE,
                  label: "Manage repositories…",
                },
              ],
            },
          ]
        : []),
    ];
  }, [
    listing,
    noRepositoryItem,
    pickerFilter,
    projectFolderRowLabel,
    query,
    repositoryPicker.groups,
    showProjectFolderRow,
    workProject,
  ]);
  const selectedPickerItem: PickerItem | null =
    heroLine.projectFolderRow === "selected"
      ? noRepositoryItem
      : (repositoryPicker.groups
          .flatMap((group) => group.items)
          .find((item) => item.kind === "repository" && item.row.key === selectedRow?.key) ?? null);

  // The picker can change the draft's target while the no-project home is
  // still being opened; a stale continuation must not retarget it again.
  const latestTargetRef = useRef({ draftId, activeProjectKey, scratchTargetEnvironmentId });
  useEffect(() => {
    latestTargetRef.current = { draftId, activeProjectKey, scratchTargetEnvironmentId };
  }, [activeProjectKey, scratchTargetEnvironmentId, draftId]);
  // The empty draft a pick leaves behind keeps no project, but only once it is
  // off screen. The router commits the new draft in a transition, after the
  // pick's navigation resolves; clearing it then would flash this heading back
  // to its repository's own project just before the new draft replaces it.
  const releaseFolderOnLeaveRef = useRef<ThreadId | null>(null);
  useEffect(
    () => () => {
      const threadId = releaseFolderOnLeaveRef.current;
      if (threadId !== null) setPendingProjectFolder(threadId, null);
    },
    [],
  );
  // With a prompt typed, project selection changes the target of the open
  // draft in place, so the prompt stays in the same composer session. An empty
  // draft instead opens the chosen project's own draft, like starting a new
  // thread there: moving it would replace that draft and strand whatever it
  // holds, such as the browser tabs of the no-project draft.
  // `folder` is the project the Work lands in; the draft keeps it
  // (workDraftFolderId), so a pick never drops the project. Callers only pass
  // a folder that holds `project` (or is linking it now), or Work without a
  // repository. `onUnavailable` runs when the draft could not move.
  const selectProject = (
    project: (typeof projects)[number],
    logicalProjectKey: string,
    folder: EnvironmentProjectLabel | null,
    options?: { readonly onUnavailable?: () => void },
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
      byKey: projectDirectory.byKey,
    });
    const fileDraft = (threadId: ThreadId) =>
      setPendingProjectFolder(
        threadId,
        folderId === null
          ? null
          : {
              environmentId: project.environmentId,
              folderId,
              repositoryId: isNoProjectHome(project) ? null : project.id,
            },
      );
    const leavingThreadId = draftThread?.threadId ?? null;
    const currentDraft = getComposerDraft(draftId);
    if (!composerDraftHasUserContent(currentDraft)) {
      void openProjectDraft(
        scopeProjectRef(project.environmentId, project.id),
        surface ? { surface } : {},
      ).then((started) => {
        if (!started) {
          options?.onUnavailable?.();
          return;
        }
        if (isChatDraft) return;
        // The project moves with the pick; the empty draft left behind keeps
        // none once it unmounts.
        if (leavingThreadId !== null && leavingThreadId !== started.threadId) {
          releaseFolderOnLeaveRef.current = leavingThreadId;
        }
        fileDraft(started.threadId);
      });
      return;
    }
    setLogicalProjectDraftThreadId(
      surfaceDraftKey(logicalProjectKey, isChatDraft ? "chat" : "work"),
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
        ? environmentSettings.defaultModelSelection
        : project.defaultModelSelection;
      if (defaultModelSelection) {
        setModelSelection(draftId, defaultModelSelection, {
          replaceOptions: true,
        });
      }
    }
  };
  // Work without a repository, filed in `folder` (the Work project by default).
  // A draft already without one is re-filed in place. `onUnavailable` runs
  // when the draft could not move there; `onNoFolderWork` when this machine
  // cannot host Work without a repository at all.
  const startScratch = async (
    folder: EnvironmentProjectLabel | null = workProject,
    options?: {
      readonly onUnavailable?: () => void;
      readonly onNoFolderWork?: () => void;
    },
  ): Promise<void> => {
    if (isScratchDraft) {
      if (!draftThread || isChatDraft || activeProject === null) return;
      const folderId = workDraftFolderId({
        repository: { environmentId: activeProject.environmentId, projectId: activeProject.id },
        project: folder,
        byKey: projectDirectory.byKey,
      });
      setPendingProjectFolder(
        draftThread.threadId,
        folderId === null
          ? null
          : {
              environmentId: activeProject.environmentId,
              folderId,
              repositoryId: null,
            },
      );
      return;
    }
    if (scratchTargetEnvironmentId === null) {
      options?.onUnavailable?.();
      options?.onNoFolderWork?.();
      return;
    }
    const requested = { draftId, activeProjectKey, scratchTargetEnvironmentId };
    const project = await openScratchProject(scratchTargetEnvironmentId);
    const latest = latestTargetRef.current;
    if (
      latest.draftId !== requested.draftId ||
      latest.activeProjectKey !== requested.activeProjectKey ||
      latest.scratchTargetEnvironmentId !== requested.scratchTargetEnvironmentId
    ) {
      return;
    }
    if (!project) {
      options?.onUnavailable?.();
      return;
    }
    selectProject(
      project,
      deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
      folder,
      options,
    );
  };

  // A picked repository becomes the draft's, in the Work project. One cloned
  // here first arrives once its clone lands, as long as the draft still
  // targets what it did.
  useEffect(() => {
    pickRepositoryRef.current = (repository) => {
      closePicker();
      const current =
        !isScratchDraft &&
        activeProjectRef !== null &&
        activeProjectRef.environmentId === repository.environmentId &&
        activeProjectRef.projectId === repository.id;
      if (current) return;
      selectProject(
        repository,
        deriveLogicalProjectKeyFromSettings(repository, projectGroupingSettings),
        workProject,
      );
    };
  });

  const renderHeroItem = (item: PickerItem) => {
    if (item.kind === "manage") {
      return (
        <ComboboxItem key={item.value} hideIndicator value={item} tone="action">
          <ManageRepositoriesRowContent />
        </ComboboxItem>
      );
    }
    if (item.kind === "no-repository") {
      return (
        <ComboboxItem key={item.value} hideIndicator value={item}>
          <PickerRowContent
            icon={<ProjectFolderRowIcon />}
            label={item.label}
            chosen={heroLine.projectFolderRow === "selected"}
          />
        </ComboboxItem>
      );
    }
    return repositoryPicker.renderItem(item);
  };

  const projectSelector = (
    <Combobox
      items={pickerGroups}
      filteredItems={pickerGroups}
      autoHighlight
      itemToStringLabel={(item: PickerItem) => item.label}
      isItemEqualToValue={(a: PickerItem, b: PickerItem) => a.value === b.value}
      open={pickerOpen}
      onOpenChange={(open, details) => {
        // Cloning, "Add repository" and "Show more" keep the picker up.
        if (!open && details.reason === "item-press" && keepPickerOpenRef.current) {
          keepPickerOpenRef.current = false;
          return;
        }
        setPickerOpen(open);
        setPickerQuery("");
        if (!open) repositoryPicker.reset();
      }}
      value={selectedPickerItem}
      onValueChange={(item: PickerItem | null) => {
        if (!item) return;
        if (item.kind === "no-repository") {
          closePicker();
          // A draft already without one settles there, out of "Choose a repository".
          void startScratch();
          return;
        }
        if (item.kind === "manage") {
          closePicker();
          if (workProject) {
            void navigate({
              to: "/settings/project-tags",
              search: {
                projectEnvironmentId: workProject.environmentId,
                projectLabelId: workProject.label.id,
              },
            });
          }
          return;
        }
        if (repositoryPicker.pick(item)) {
          keepPickerOpenRef.current = true;
          setPickerQuery("");
        }
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
                  weight="normal"
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
              // The same icon the picker's row shows for it.
              <span className="inline-flex size-[0.78em] align-[-0.06em] me-[0.28em] items-center justify-center">
                <RepositoryRowIcon
                  local={activeProject}
                  {...(activeProject
                    ? linkedRepositoryIcon(repositoryFolder, activeProject.id)
                    : { remote: null, iconPath: null })}
                  environmentId={activeProject?.environmentId ?? null}
                  // Sized in em to the heading, like the hero's other inline icons.
                  className="size-full"
                />
              </span>
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
          placeholder={repositoryPicker.searchPlaceholder}
          value={pickerQuery}
          onChange={(event) => setPickerQuery(event.target.value)}
          onKeyDown={(event) => {
            repositoryPicker.onSearchKeyDown(event);
          }}
        />
        <ComboboxEmpty>{repositoryPicker.emptyText}</ComboboxEmpty>
        <ComboboxList>
          {(group: PickerGroup) => (
            <ComboboxGroup
              key={group.value}
              items={group.items}
              // Action rows carry their own divider; no group gap on top of that.
              className={
                group.shared?.tight === true || group.value === MANAGE_REPOSITORIES_VALUE
                  ? "not-first:mt-0"
                  : undefined
              }
            >
              {/* A switch to "Add repository" and back swaps the rows in with a fade. */}
              <div key={repositoryPicker.mode} className="reveal-motion">
                {group.shared ? (
                  <RepositoryPickerGroupContent
                    group={group.shared}
                    renderItem={repositoryPicker.renderItem}
                  />
                ) : (
                  <ComboboxGroupItems inset={false}>
                    <ComboboxCollection>
                      {(item: PickerItem) => renderHeroItem(item)}
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

  // The composer hero is a sentence, so the heading's accessible name must be
  // a complete sentence too. The project picker is a control rendered inline
  // in the h1; without an explicit label its widget state bleeds into the
  // announced phrase.
  // Fixed when the screen opens, so the line holds still while the user types.
  const greeting = useChatGreeting(draftThread?.environmentId ?? primaryEnvironmentId);
  // A chat picked into a project says so after the greeting, quietly.
  const greetingSuffix = heroProjectSuffix(pendingProject?.label.name ?? null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useHeroHeadlineMotion(headingRef, isChatDraft ? "chat" : "work");
  // A project picked for this Work draft, in the hero or the toolbar, moves it
  // into the project (projectSwitchRepository): the current repository while
  // the project holds it, else its only one, else the project's folder. A
  // draft whose project does not hold its repository (left from before this
  // rule) is moved the same way. When the draft cannot move, it leaves the
  // project instead, with a note when the machine can't run Work without a
  // repository: a repository never pairs with a project outside it. "No
  // project" moves it to the most recently active repository in no project.
  const noProjectPicked = useWorkNoProjectPicked(draftThread?.threadId);
  // The project move last started, so a re-render while it lands does not repeat it.
  const projectMoveRef = useRef<string | null>(null);
  useEffect(() => {
    if (!draftThread) return;
    const threadId = draftThread.threadId;
    const choseProject = pendingFolder?.chosen === true && pendingProject !== null;
    const correcting = !choseProject && !isChatDraft && draftProject.stale;
    if (!choseProject && !noProjectPicked && !correcting) return;
    // A project picked after "No project" wins.
    if (noProjectPicked) answerNoProjectPick(threadId);
    if (choseProject && pendingFolder) {
      setPendingProjectFolder(threadId, {
        environmentId: pendingFolder.environmentId,
        folderId: pendingFolder.folderId,
      });
    }
    if (isChatDraft) return;
    const project = choseProject || correcting ? pendingProject : null;
    if (project !== null) {
      const move = `${threadId}:${project.key}:${isScratchDraft ? "none" : activeProjectKey}`;
      if (correcting && projectMoveRef.current === move) return;
      projectMoveRef.current = move;
      const leaveProject = () => setPendingProjectFolder(threadId, null);
      const next = projectSwitchRepository({
        project,
        current: activeRepositoryRef,
        items: repositoryItems,
        refsOf: refsOfRepository,
      });
      switch (next.kind) {
        case "keep": {
          if (activeProject === null) return;
          // Staying put: the project stays filed unless this machine lacks it.
          const folderId = workDraftFolderId({
            repository: { environmentId: activeProject.environmentId, projectId: activeProject.id },
            project,
            byKey: projectDirectory.byKey,
          });
          if (folderId === null) leaveProject();
          return;
        }
        case "select": {
          const entry = projectEntryByKey.get(next.item.projectKey);
          if (!entry) return;
          // The member the project holds, on the draft's machine when it has one.
          const held = entry.group.memberProjects.filter((member) =>
            projectHoldsRepository(project, {
              environmentId: member.environmentId,
              projectId: member.id,
            }),
          );
          const member =
            held.find((candidate) => candidate.environmentId === pickerEnvironmentId) ??
            held[0] ??
            entry.targetProject;
          selectProject(member, entry.group.projectKey, project, { onUnavailable: leaveProject });
          return;
        }
        case "project-folder":
          void startScratch(project, {
            onUnavailable: leaveProject,
            // Says why the pick did not stick, rather than dropping it silently.
            onNoFolderWork: () =>
              toastManager.add({
                type: "info",
                ...projectDroppedNote(
                  project.label.name,
                  environmentLabelById.get(pickerEnvironmentId ?? project.environmentId) ?? null,
                ),
              }),
          });
          return;
      }
    }
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
      project: null,
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
        selectProject(entry.targetProject, entry.group.projectKey, null);
      }
      return;
    }
    // Nothing to run in: Work goes without a repository, in no project.
    if (!isScratchDraft) void startScratch(null);
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
    <div className="@container flex w-full flex-col items-center">
      <h1
        ref={headingRef}
        style={{ fontSize: "clamp(var(--text-xl), 3cqw, var(--text-3xl))" }}
        aria-label={headingLabel}
        className="group/hero-headline relative w-full origin-bottom text-balance text-center font-normal text-xl text-foreground tracking-tight"
      >
        <FadeSwap
          group={DRAFT_HEADING_GROUP}
          // A chat's project and Work's breadcrumb change in place, not by a swap.
          swapKey={isChatDraft ? "chat" : "work"}
        >
          {isChatDraft ? (
            <>
              <span data-hero-greeting="" className="inline">
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

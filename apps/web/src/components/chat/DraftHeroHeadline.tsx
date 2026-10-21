import type { DraftId } from "~/composerDraftStore";
import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
import {
  type EnvironmentId,
  resolveEnvironmentMachineKind,
  type ScopedProjectRef,
  type ThreadSurface,
} from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { FolderGit2Icon, FolderIcon, FolderPlusIcon, ListIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
import { HERO_INLINE_ICON_STYLE, HeroProjectPicker } from "~/projectLabels/HeroProjectPicker";
import { usePendingProjectFolderStore } from "~/projectLabels/pendingProjectFolders";
import {
  projectLabelKey,
  type EnvironmentProjectLabel,
  type ProjectLabelKey,
} from "~/projectLabels/projectLabels.logic";
import {
  groupRepositoriesByProject,
  heroProjectKey,
  heroProjectSuffix,
  isRepositoryGroupOpen,
  OTHER_REPOSITORIES_GROUP_KEY,
  soleRepositoryOf,
  toggleCollapsedGroup,
} from "~/projectLabels/projectMeta.logic";
import { ProjectFolderIcon } from "~/projectLabels/ProjectFolderMark";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import * as Schema from "effect/Schema";
import { useProjectLabelDirectory } from "~/projectLabels/useProjectLabels";
import { chatGreeting } from "./chatGreeting";
import { FadeSwap } from "./StateTransition";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupCollapse,
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
import { InlineButton } from "../ui/button";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

// Picker values for the action rows; repositories are keyed by their group
// and logical project key, since one can show under several projects.
const ADD_PROJECT_VALUE = "add-project";
const ALL_REPOSITORIES_VALUE = "all-repositories";
const ACTIONS_GROUP_KEY = "actions";
const COLLAPSED_GROUPS_STORAGE_KEY = "cogenly:repository-picker:collapsed-projects";
const CollapsedGroupKeys = Schema.mutable(Schema.Array(Schema.String));
const EMPTY_GROUP_KEYS: string[] = [];

interface PickerItem {
  readonly value: string;
  readonly label: string;
  /** The logical project key; empty on action rows. */
  readonly projectKey: string;
  /** The project group the row is listed under. */
  readonly groupKey: string;
}

interface PickerGroup {
  readonly value: string;
  /** The header; null on a list with no projects, and on the actions. */
  readonly label: string | null;
  readonly color: string | undefined;
  readonly isProject: boolean;
  readonly items: readonly PickerItem[];
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
  // The project the repository was picked under, so the hero names it.
  const [chosenProjectKey, setChosenProjectKey] = useState<ProjectLabelKey | null>(null);
  // Picking a project with several repositories narrows the picker to them.
  const [pickerProjectKey, setPickerProjectKey] = useState<ProjectLabelKey | null>(null);
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
    (items: readonly PickerItem[], onlyProject: ProjectLabelKey | null, withActions: boolean) => {
      const grouped = groupRepositoriesByProject({
        items,
        refsOf: refsOfRepository,
        projects: projectDirectory.labels,
        onlyProject,
      });
      // Without any project there is nothing to group by: one plain list.
      const titled = grouped.some((group) => group.project !== null);
      const groups: PickerGroup[] = grouped.map((group) => ({
        value: group.key,
        label: titled ? (group.project?.label.name ?? "Other repositories") : null,
        color: group.project?.label.color,
        isProject: group.project !== null,
        items: group.items.map((item) => ({
          ...item,
          value: `${group.key}|${item.projectKey}`,
          groupKey: group.key,
        })),
      }));
      if (withActions) {
        groups.push({
          value: ACTIONS_GROUP_KEY,
          label: null,
          color: undefined,
          isProject: false,
          items: [
            ...(onlyProject
              ? [
                  {
                    value: ALL_REPOSITORIES_VALUE,
                    label: "All repositories",
                    projectKey: "",
                    groupKey: ACTIONS_GROUP_KEY,
                  },
                ]
              : []),
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
    () => buildPickerGroups(repositoryItems, null, true),
    [buildPickerGroups, repositoryItems],
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
  // Search runs across every repository, whatever project the list was narrowed to.
  const filteredPickerGroups = useMemo(() => {
    const query = pickerQuery.trim();
    if (query.length === 0) return buildPickerGroups(repositoryItems, pickerProjectKey, true);
    return buildPickerGroups(
      repositoryItems.filter((item) =>
        pickerFilter.contains(item, query, (candidate) => candidate.label),
      ),
      null,
      false,
    );
  }, [buildPickerGroups, pickerFilter, pickerProjectKey, pickerQuery, repositoryItems]);
  const activeRepositoryRefs = activeProjectGroup?.memberProjectRefs;
  const heroProject = useMemo(() => {
    if (isScratchDraft || !activeRepositoryRefs) return null;
    const key = heroProjectKey({
      chosen: chosenProjectKey,
      repository: activeRepositoryRefs,
      projects: projectDirectory.labels,
    });
    return key === null ? null : (projectDirectory.byKey.get(key) ?? null);
  }, [activeRepositoryRefs, chosenProjectKey, isScratchDraft, projectDirectory]);
  const selectedPickerItem =
    pickerGroups
      .find((group) => group.value === (heroProject?.key ?? OTHER_REPOSITORIES_GROUP_KEY))
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
  const selectProject = (project: (typeof projects)[number], logicalProjectKey: string) => {
    if (!draftId) {
      return;
    }
    latestTargetRef.current = {
      draftId,
      activeProjectKey: logicalProjectKey,
      scratchTargetEnvironmentId: project.environmentId,
    };
    const currentDraft = getComposerDraft(draftId);
    if (!composerDraftHasUserContent(currentDraft)) {
      void openProjectDraft(scopeProjectRef(project.environmentId, project.id), {
        ...(surface ? { surface } : {}),
      });
      return;
    }
    setLogicalProjectDraftThreadId(
      logicalProjectKey,
      scopeProjectRef(project.environmentId, project.id),
      draftId,
    );
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
    selectProject(project, deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings));
    return true;
  };

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
          ) : item.value === ALL_REPOSITORIES_VALUE ? (
            <ListIcon className="size-4" />
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

  const projectSelector = shouldShowProjectMenu ? (
    <Combobox
      items={pickerGroups}
      filteredItems={filteredPickerGroups}
      autoHighlight
      itemToStringLabel={(item: PickerItem) => item.label}
      isItemEqualToValue={(a: PickerItem, b: PickerItem) => a.value === b.value}
      open={pickerOpen}
      onOpenChange={(open, details) => {
        // "All repositories" widens the list in place.
        if (!open && details.reason === "item-press" && keepPickerOpenRef.current) {
          keepPickerOpenRef.current = false;
          return;
        }
        setPickerOpen(open);
        setPickerQuery("");
        if (!open) setPickerProjectKey(null);
      }}
      value={selectedPickerItem}
      onValueChange={(item: PickerItem | null) => {
        if (!item) return;
        if (item.value === ALL_REPOSITORIES_VALUE) {
          keepPickerOpenRef.current = true;
          setPickerProjectKey(null);
          return;
        }
        setPickerOpen(false);
        setPickerProjectKey(null);
        if (item.value === ADD_PROJECT_VALUE) {
          openAddProject();
          return;
        }
        // Picking a repository under a project also picks that project.
        setChosenProjectKey(
          item.groupKey === OTHER_REPOSITORIES_GROUP_KEY
            ? null
            : (item.groupKey as ProjectLabelKey),
        );
        const entry = projectEntryByKey.get(item.projectKey);
        if (!entry || item.projectKey === activeProjectKey) {
          return;
        }
        selectProject(entry.targetProject, entry.group.projectKey);
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
      <ComboboxPopup align="center" sideOffset={8} className="w-72">
        <ComboboxSearchInput
          aria-label="Search repositories"
          placeholder="Search repositories…"
          value={pickerQuery}
          onChange={(event) => setPickerQuery(event.target.value)}
        />
        <ComboboxEmpty>No matching repositories.</ComboboxEmpty>
        <ComboboxList>
          {(group: PickerGroup) => (
            <ComboboxGroup key={group.value} items={group.items}>
              {group.label !== null ? (
                <RepositoryPickerGroupBody
                  group={group}
                  open={isRepositoryGroupOpen({
                    groupKey: group.value,
                    collapsedKeys: collapsedGroupKeys,
                    searching: pickerQuery.trim().length > 0,
                    hasMatches: group.items.length > 0,
                  })}
                  onToggle={() =>
                    setCollapsedGroupKeys((keys) => toggleCollapsedGroup(keys, group.value))
                  }
                  renderItem={renderPickerItem}
                />
              ) : (
                <ComboboxCollection>
                  {(item: PickerItem) => renderPickerItem(item)}
                </ComboboxCollection>
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
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.draftThreadsByThreadKey[draftId] : undefined,
  );
  const pendingFolder = usePendingProjectFolderStore((store) =>
    draftThread ? store.byThreadId[draftThread.threadId] : undefined,
  );
  const chatProjectName = pendingFolder
    ? (projectDirectory.byKey.get(
        projectLabelKey(pendingFolder.environmentId, pendingFolder.folderId),
      )?.label.name ?? null)
    : null;
  const greetingSuffix = heroProjectSuffix(chatProjectName);
  // Choosing a project in the hero: one repository is picked outright;
  // several narrow the repository picker to that project's.
  const chooseHeroProject = (project: EnvironmentProjectLabel) => {
    setChosenProjectKey(project.key);
    const narrowed = groupRepositoriesByProject({
      items: repositoryItems,
      refsOf: refsOfRepository,
      projects: projectDirectory.labels,
      onlyProject: project.key,
    });
    const sole = soleRepositoryOf(narrowed);
    if (sole) {
      const entry = projectEntryByKey.get(sole.projectKey);
      if (entry && sole.projectKey !== activeProjectKey) {
        selectProject(entry.targetProject, entry.group.projectKey);
      }
      return;
    }
    setPickerProjectKey(project.key);
    setPickerOpen(true);
  };
  const heroProjectPart = heroProject ? (
    <>
      <HeroProjectPicker
        projects={projectDirectory.labels.filter((entry) =>
          groupRepositoriesByProject({
            items: repositoryItems,
            refsOf: refsOfRepository,
            projects: [entry],
            onlyProject: entry.key,
          }).some((group) => group.items.length > 0),
        )}
        current={heroProject}
        onChoose={chooseHeroProject}
      />
      <span className="text-muted-foreground/60"> / </span>
    </>
  ) : null;
  const headingLabel = isChatDraft
    ? `${greeting}${greetingSuffix ?? ""}`
    : isScratchDraft
      ? "What should we build?"
      : hasResolvedProject
        ? `What should we build in ${heroProject ? `${heroProject.label.name} / ` : ""}${activeProjectDisplayName}?`
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
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <h1
        aria-label={headingLabel}
        className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl"
      >
        <FadeSwap
          group="draft-heading"
          swapKey={
            isChatDraft
              ? `chat:${chatProjectName ?? ""}`
              : isScratchDraft
                ? "no-repository"
                : `repository:${heroProject?.key ?? ""}:${activeProjectKey}`
          }
        >
          {isChatDraft ? (
            <>
              {greeting}
              {greetingSuffix ? (
                <span className="text-muted-foreground/60">{greetingSuffix}</span>
              ) : null}
            </>
          ) : isScratchDraft ? (
            <>What should we build?</>
          ) : hasResolvedProject ? (
            <>
              What should we build in {heroProjectPart}
              {projectSelector}?
            </>
          ) : canChooseProject ? (
            <>{projectSelector} to start</>
          ) : (
            <>Add a repository to start</>
          )}
        </FadeSwap>
      </h1>
      {/* Reserved whenever threads can skip a project, so the heading does not
          move. Without a project, the picker moves here to choose one. */}
      {isChatDraft || (scratchWorkspaceRoot === null && !isScratchDraft) ? null : (
        <p className="mt-2 flex h-6 items-center text-sm">
          <FadeSwap group="draft-subline" swapKey={isScratchDraft ? "picker" : "start-without"}>
            {isScratchDraft ? projectSelector : orStartWithoutProject}
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

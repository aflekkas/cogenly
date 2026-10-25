import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@cogenly/client-runtime/state/runtime";
import type { EnvironmentProject } from "@cogenly/client-runtime/state/models";
import { type EnvironmentId, ProjectId } from "@cogenly/contracts";
import { ChevronLeftIcon, FolderPlusIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { openCommandPalette } from "../commandPaletteBus";
import {
  ComboboxCollection,
  ComboboxGroupItems,
  ComboboxItem,
  useComboboxFilter,
} from "../components/ui/combobox";
import { requestConfirmDialog } from "../confirmDialog";
import { useProjects, useServerConfigs } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  projectLabelKey,
  repositoryFolderMove,
  scopedRepositoryKey,
  type EnvironmentProjectLabel,
} from "./projectLabels.logic";
import { isPickableRepository } from "./projectMeta.logic";
import { linkedGitHubOwners, type OwnerSearchState } from "./projectSourceLinks.logic";
import {
  addRepositoryOptions,
  linkedRepositoryRows,
  machineRepositoryRows,
  repositoryRowAction,
  type AddRepositoryOption,
  type RepositoryListRow,
} from "./repositoryPicker.logic";
import {
  GitHubRepositoryRow,
  GitHubSearchStatus,
  PickerRowContent,
  RepositoryPickerRow,
  RepositoryRowError,
  RepositoryRowIcon,
  RepositoryRowMenu,
  RepositoryRowStatus,
  ShowMoreRemoteRow,
} from "./RepositorySourceRows";
import { reportProjectFolderFailure } from "./useMoveThreadToFolder";
import { useOwnerRepositorySearch } from "./useOwnerRepositorySearch";
import { useProjectLabelDirectory } from "./useProjectLabels";
import { useRemoteRepositoryClone } from "./useRemoteRepositoryClone";
import { useRepositoryCheckouts, useRepositoryRowActions } from "./useRepositoryCheckout";

export type RepositoryRow = RepositoryListRow<EnvironmentProject>;

/** A row the shared repository list puts in a picker. */
export type RepositoryPickerItem =
  | {
      readonly kind: "repository";
      readonly value: string;
      readonly label: string;
      readonly row: RepositoryRow;
    }
  /** Opens "Add repository" in place (with no project, the palette's add flow). */
  | { readonly kind: "add"; readonly value: string; readonly label: string }
  | { readonly kind: "back"; readonly value: string; readonly label: string }
  | {
      readonly kind: "add-option";
      readonly value: string;
      readonly label: string;
      readonly option: AddRepositoryOption<EnvironmentProject>;
    }
  | {
      readonly kind: "add-more";
      readonly value: string;
      readonly label: string;
      readonly hidden: number;
    }
  /** The palette's flow for a folder or a clone URL, filed in the project. */
  | { readonly kind: "add-other"; readonly value: string; readonly label: string };

export interface RepositoryPickerGroup {
  readonly value: string;
  readonly items: ReadonlyArray<RepositoryPickerItem>;
  /** An action row's group, whose own divider spaces it: no group gap above it. */
  readonly tight?: boolean;
  /** Set on "Add repository"'s list: the GitHub search's slow or failed line under it. */
  readonly gitHub?: {
    readonly state: OwnerSearchState | undefined;
    readonly owners: ReadonlyArray<string>;
  };
}

const ADD_VALUE = "repository-picker:add";
const BACK_VALUE = "repository-picker:back";
const MORE_VALUE = "repository-picker:more";
const OTHER_VALUE = "repository-picker:other";

/**
 * The one repository list every picker shows, for one machine: inside a
 * project, every repository it links with its state there (picking one that
 * is not cloned here clones it, then picks it); with no project, the
 * machine's repositories. A last row opens "Add repository" in place: this
 * machine's other repositories to link and the project's GitHub repositories
 * to clone. Hosts put `groups` in their combobox, route picks through
 * `pick` (true keeps the picker open), render rows with `renderItem`, and
 * call `reset` when the picker closes.
 */
export function useRepositoryPicker(input: {
  /** The selected machine. */
  readonly environmentId: EnvironmentId | null;
  /** The project whose repositories list; null lists the machine's. */
  readonly project: EnvironmentProjectLabel | null;
  /** With no project, list only the machine's repositories that are in none. */
  readonly unfiledOnly?: boolean;
  readonly open: boolean;
  readonly query: string;
  /** Show only "Add repository" (the project page's add button). */
  readonly addOnly?: boolean;
  readonly leadRepositoryId?: ProjectId | null;
  /** A repository was picked, linked, or cloned and is ready here. */
  readonly onPick: (repository: EnvironmentProject) => void;
  /** A launch service can resolve a remote-only row after choosing its machine. */
  readonly onPickUncloned?: (repositoryId: ProjectId) => void;
  /** The picker gives way to a dialog or another surface. */
  readonly onClose: () => void;
}) {
  const { environmentId, open, query } = input;
  const trimmed = query.trim();
  const projects = useProjects();
  const scratchRoot =
    useServerConfigs().get(environmentId ?? ("" as EnvironmentId))?.scratchWorkspaceRoot ?? null;
  const environmentIds = useMemo(
    () => (environmentId === null ? [] : [environmentId]),
    [environmentId],
  );
  const directory = useProjectLabelDirectory(environmentIds);
  // Projects sync across machines; each machine reports its own checkouts,
  // so the project is read as the selected machine has it.
  const project = useMemo(() => {
    if (input.project === null || environmentId === null) return null;
    return (
      directory.byKey.get(projectLabelKey(environmentId, input.project.label.id)) ??
      (input.project.environmentId === environmentId ? input.project : null)
    );
  }, [directory.byKey, environmentId, input.project]);
  const machineProjects = useMemo(
    () => projects.filter((candidate) => candidate.environmentId === environmentId),
    [environmentId, projects],
  );
  const localById = useMemo(
    () => new Map(machineProjects.map((candidate) => [candidate.id, candidate] as const)),
    [machineProjects],
  );
  const pickable = useMemo(
    () => machineProjects.filter((candidate) => isPickableRepository(candidate, scratchRoot)),
    [machineProjects, scratchRoot],
  );
  const rows = useMemo((): RepositoryRow[] => {
    if (input.project !== null) {
      return project === null
        ? []
        : linkedRepositoryRows({
            project,
            localById,
            leadRepositoryId: input.leadRepositoryId ?? null,
          });
    }
    const locals =
      input.unfiledOnly === true && environmentId !== null
        ? pickable.filter(
            (candidate) =>
              !directory.folderByRepository.has(scopedRepositoryKey(environmentId, candidate.id)),
          )
        : pickable;
    return machineRepositoryRows({
      locals,
      projects: directory.active,
      leadRepositoryId: input.leadRepositoryId ?? null,
    });
  }, [
    directory,
    environmentId,
    input.leadRepositoryId,
    input.project,
    input.unfiledOnly,
    localById,
    pickable,
    project,
  ]);

  const [addView, setAddView] = useState(false);
  const [showAllRemote, setShowAllRemote] = useState(false);
  const mode: "list" | "add" =
    project !== null && (input.addOnly === true || addView) ? "add" : "list";

  const filter = useComboboxFilter();

  const searchedProjects = useMemo(() => (project ? [project] : []), [project]);
  const ownerSearch = useOwnerRepositorySearch(searchedProjects, query, open && mode === "add");
  const gitHubState = project ? ownerSearch.get(project.key) : undefined;
  const addOptions = useMemo(
    (): {
      readonly options: ReadonlyArray<AddRepositoryOption<EnvironmentProject>>;
      readonly hidden: number;
    } =>
      project === null
        ? { options: [], hidden: 0 }
        : addRepositoryOptions({
            project,
            locals: pickable,
            folderOf: (candidate) =>
              directory.folderByRepository.get(
                scopedRepositoryKey(project.environmentId, candidate.id),
              ) ?? null,
            gitHub: gitHubState?.status === "done" ? gitHubState.repositories : [],
            searching: trimmed.length > 0,
            expanded: showAllRemote,
          }),
    [directory.folderByRepository, gitHubState, pickable, project, showAllRemote, trimmed],
  );

  const groups = useMemo((): RepositoryPickerGroup[] => {
    const matches = (text: string | null) =>
      trimmed.length === 0 ||
      (text !== null && filter.contains(text, trimmed, (candidate) => candidate));
    if (mode === "list") {
      const repositoryItems = rows
        .filter((row) => matches(row.name) || matches(row.detail))
        .map((row): RepositoryPickerItem => ({
          kind: "repository",
          value: `repository:${row.key}`,
          label: row.name,
          row,
        }));
      return [
        { value: "repository-picker:rows", items: repositoryItems },
        ...(trimmed.length === 0
          ? [
              {
                value: "repository-picker:actions",
                tight: true,
                items: [{ kind: "add" as const, value: ADD_VALUE, label: "Add repository…" }],
              },
            ]
          : []),
      ];
    }
    const options = addOptions.options
      .filter((option) => matches(option.name))
      .map((option): RepositoryPickerItem => ({
        kind: "add-option",
        value: `repository-picker:${option.key}`,
        label: option.name,
        option,
      }));
    return [
      ...(input.addOnly === true
        ? []
        : [
            {
              value: BACK_VALUE,
              items: [
                {
                  kind: "back" as const,
                  value: BACK_VALUE,
                  label: project ? `Back to ${project.label.name}` : "Back",
                },
              ],
            },
          ]),
      {
        value: "repository-picker:options",
        gitHub: { state: gitHubState, owners: project ? linkedGitHubOwners(project) : [] },
        items: [
          ...options,
          ...(addOptions.hidden > 0
            ? [
                {
                  kind: "add-more" as const,
                  value: MORE_VALUE,
                  label: `Show ${addOptions.hidden} more`,
                  hidden: addOptions.hidden,
                },
              ]
            : []),
        ],
      },
      ...(trimmed.length === 0
        ? [
            {
              value: OTHER_VALUE,
              tight: true,
              items: [
                { kind: "add-other" as const, value: OTHER_VALUE, label: "From a folder or URL…" },
              ],
            },
          ]
        : []),
    ];
  }, [addOptions, filter, gitHubState, input.addOnly, mode, project, rows, trimmed]);

  const checkouts = useRepositoryCheckouts(environmentId);
  const rowActions = useRepositoryRowActions(environmentId, checkouts);
  const canLink = useAtomValue(
    serverEnvironment.linkProjectLabelRepository.permissionAtom(environmentId),
  );
  const link = useAtomCommand(serverEnvironment.linkProjectLabelRepository, {
    label: "add repository to project",
    reportFailure: false,
  });
  const remoteClone = useRemoteRepositoryClone(
    (target) =>
      open &&
      mode === "add" &&
      addOptions.options.some(
        (option) =>
          option.kind === "github" &&
          target.project.key === project?.key &&
          option.repository.nameWithOwner === target.repository.nameWithOwner,
      ),
  );

  const onPickRef = useRef(input.onPick);
  useEffect(() => {
    onPickRef.current = input.onPick;
  });
  // A row cloned here from the list is picked once it is ready: the link
  // reports it cloned and its record has reached this window.
  // A ref, not state: nothing renders from it, and the effect runs on every
  // render the clone's progress causes anyway.
  const pendingPickKey = useRef<string | null>(null);
  useEffect(() => {
    if (pendingPickKey.current === null) return;
    const key = pendingPickKey.current;
    const row = rows.find((candidate) => candidate.key === key);
    if (!row || row.checkout !== "ready") return;
    const startedId = checkouts.startedRepositoryId(row);
    const local = row.local ?? (startedId === null ? null : (localById.get(startedId) ?? null));
    if (local === null) return;
    pendingPickKey.current = null;
    checkouts.forget(row);
    onPickRef.current(local);
  });
  // A GitHub repository cloned from "Add repository" is picked once it lands.
  const pickAfterCloneRef = useRef(false);
  const clonedRef = remoteClone.view?.phase === "done" ? remoteClone.ref : null;
  useEffect(() => {
    if (clonedRef === null) return;
    const cloned = projects.find(
      (candidate) =>
        candidate.environmentId === clonedRef.environmentId && candidate.id === clonedRef.projectId,
    );
    if (!cloned) return;
    remoteClone.release();
    if (!pickAfterCloneRef.current) return;
    pickAfterCloneRef.current = false;
    setAddView(false);
    onPickRef.current(cloned);
  });

  const addLocal = async (target: EnvironmentProjectLabel, local: EnvironmentProject) => {
    const move = repositoryFolderMove(
      target.key,
      directory.folderByRepository.get(scopedRepositoryKey(target.environmentId, local.id)),
    );
    input.onClose();
    if (move.needsConfirm && move.from) {
      const message = `Move ${local.title} to ${target.label.name}?\nIt leaves ${move.from.label.name}. A repository is in one project at a time, and its Work moves with it.`;
      const confirmed =
        (await requestConfirmDialog(message)) ?? window.confirm(message.replace("\n", " "));
      if (!confirmed) return;
    }
    const result = await link({
      environmentId: target.environmentId,
      input: { labelId: target.label.id, repositoryId: local.id },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportProjectFolderFailure(`Could not add ${local.title}`, result);
      }
      return;
    }
    onPickRef.current(local);
  };

  /** Handles a pick; true keeps the picker open. */
  const pick = (item: RepositoryPickerItem): boolean => {
    switch (item.kind) {
      case "repository": {
        const { row } = item;
        if (row.local === null && row.remote !== null && input.onPickUncloned !== undefined) {
          input.onPickUncloned(ProjectId.make(`remote:${row.remote}`));
          return false;
        }
        const view = checkouts.viewOf(row);
        // A row being removed or moved here is not picked mid-way.
        if (view.kind === "working") return true;
        if (repositoryRowAction(row) === "select" && row.local !== null) {
          input.onPick(row.local);
          return false;
        }
        if (
          (view.kind === "needs-clone" || view.kind === "failed") &&
          view.cloneable &&
          row.project !== null
        ) {
          pendingPickKey.current = row.key;
          void checkouts.start({ ...row, project: row.project });
        }
        return true;
      }
      case "add":
        if (project === null) {
          input.onClose();
          openCommandPalette({ open: "add-project" });
          return false;
        }
        setAddView(true);
        return true;
      case "back":
        setAddView(false);
        setShowAllRemote(false);
        return true;
      case "add-more":
        setShowAllRemote(true);
        return true;
      case "add-other":
        input.onClose();
        openCommandPalette(
          project
            ? {
                open: "add-project",
                into: { environmentId: project.environmentId, labelId: project.label.id },
              }
            : { open: "add-project" },
        );
        return false;
      case "add-option": {
        if (project === null) return true;
        const { option } = item;
        if (option.kind === "local") {
          if (canLink) void addLocal(project, option.local);
          return !canLink;
        }
        const target = { project, repository: option.repository };
        const view = remoteClone.isFor(target) ? remoteClone.view : null;
        if (view?.phase === "starting" || view?.phase === "running") return true;
        pickAfterCloneRef.current = true;
        if (view?.phase === "failed" || view?.phase === "cancelled") {
          void remoteClone.retry();
          return true;
        }
        void remoteClone.start(target);
        return true;
      }
    }
  };

  const hasRows = rows.length > 0;
  const renderItem = (item: RepositoryPickerItem): ReactNode => {
    switch (item.kind) {
      case "repository": {
        const { row } = item;
        const view = checkouts.viewOf(row);
        return (
          <RepositoryPickerRow
            key={item.value}
            item={item}
            icon={
              <RepositoryRowIcon
                local={row.local}
                remote={row.remote}
                environmentId={row.project?.environmentId ?? environmentId}
                iconPath={row.iconPath}
              />
            }
            name={row.name}
            tooltip={row.remote ?? row.name}
            detail={row.detail}
            trailing={<RepositoryRowStatus view={view} />}
            menu={
              <RepositoryRowMenu
                label={`${row.name} actions`}
                actions={rowActions(row, {
                  onLeave: input.onClose,
                  // Unlinking is offered inside a project, as it was.
                  unlink: input.project !== null,
                })}
              />
            }
            below={<RepositoryRowError view={view} name={row.name} />}
          />
        );
      }
      case "add":
      case "add-other":
        return (
          <ComboboxItem
            key={item.value}
            hideIndicator
            value={item}
            tone="action"
            divider={item.kind === "add" ? hasRows : true}
          >
            <PickerRowContent icon={<FolderPlusIcon className="size-4" />} label={item.label} />
          </ComboboxItem>
        );
      case "back":
        return (
          <ComboboxItem key={item.value} hideIndicator value={item} tone="action">
            <PickerRowContent icon={<ChevronLeftIcon className="size-4" />} label={item.label} />
          </ComboboxItem>
        );
      case "add-more":
        return <ShowMoreRemoteRow key={item.value} item={item} hidden={item.hidden} />;
      case "add-option": {
        const { option } = item;
        if (option.kind === "local") {
          return (
            <RepositoryPickerRow
              key={item.value}
              item={item}
              icon={<RepositoryRowIcon local={option.local} remote={null} environmentId={null} />}
              name={option.name}
              tooltip={
                project
                  ? `Add ${option.name} to ${project.label.name}${option.from ? ` (it leaves ${option.from.label.name})` : ""}`
                  : option.name
              }
              detail={option.from ? `in ${option.from.label.name}` : null}
            />
          );
        }
        const target = project ? { project, repository: option.repository } : null;
        return (
          <GitHubRepositoryRow
            key={item.value}
            item={item}
            repository={option.repository}
            name={option.name}
            clone={remoteClone}
            view={target && remoteClone.isFor(target) ? remoteClone.view : null}
            environmentId={project?.environmentId ?? null}
          />
        );
      }
    }
  };

  return {
    mode,
    project,
    rows,
    groups,
    pick,
    renderItem,
    searchPlaceholder: mode === "add" ? "Search this machine and GitHub…" : "Search repositories…",
    emptyText:
      mode === "add" && gitHubState?.status === "loading"
        ? null
        : mode === "add"
          ? "Nothing more to add."
          : "No matching repositories.",
    /** "Add repository"'s ← and Backspace in an empty search go back to the list. */
    onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>): boolean => {
      if (mode !== "add" || input.addOnly === true) return false;
      if (event.key !== "ArrowLeft" && event.key !== "Backspace") return false;
      if (event.currentTarget.value.length > 0) return false;
      event.preventDefault();
      setAddView(false);
      setShowAllRemote(false);
      return true;
    },
    reset: () => {
      setAddView(false);
      setShowAllRemote(false);
      pendingPickKey.current = null;
    },
  };
}

/** One of the shared list's groups inside a host's `ComboboxGroup`. */
export function RepositoryPickerGroupContent(props: {
  readonly group: RepositoryPickerGroup;
  readonly renderItem: (item: RepositoryPickerItem) => ReactNode;
}) {
  return (
    <>
      {/* One flat list: no headers, so no inset. */}
      <ComboboxGroupItems inset={false}>
        <ComboboxCollection>
          {(item: RepositoryPickerItem) => props.renderItem(item)}
        </ComboboxCollection>
      </ComboboxGroupItems>
      {props.group.gitHub ? (
        <GitHubSearchStatus state={props.group.gitHub.state} owners={props.group.gitHub.owners} />
      ) : null}
    </>
  );
}

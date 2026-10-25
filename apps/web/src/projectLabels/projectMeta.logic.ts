/**
 * How a thread or repository names its project (folder) outside the Projects
 * page: the sidebar row subtext, the composer's project picker, the hero line
 * and the repository picker's project groups.
 */
import type { EnvironmentId, ProjectId, ProjectLabelId } from "@cogenly/contracts";
import { normalizeProjectPathForComparison } from "@cogenly/shared/path";

import {
  projectLabelCopies,
  projectLabelKey,
  projectLabelOn,
  projectRepositoryCount,
  scopedRepositoryKey,
  threadProjectFolderId,
  type EnvironmentProjectLabel,
  type ProjectLabelKey,
} from "./projectLabels.logic";

/** The project a row names under its title. */
export interface ThreadProjectMeta {
  readonly key: ProjectLabelKey;
  readonly name: string;
  readonly color: string | undefined;
}

/** The thread's project for its subtext; null when unfiled or the folder is unknown here. */
export function threadProjectMeta(
  thread: {
    readonly environmentId: EnvironmentId;
    readonly source: { readonly projectFolderId?: ProjectLabelId | null | undefined };
  },
  byKey: ReadonlyMap<ProjectLabelKey, EnvironmentProjectLabel>,
): ThreadProjectMeta | null {
  const folderId = threadProjectFolderId(thread);
  if (folderId === null) return null;
  const entry = byKey.get(projectLabelKey(thread.environmentId, folderId));
  return entry ? { key: entry.key, name: entry.label.name, color: entry.label.color } : null;
}

/**
 * The folder the composer shows for a thread or draft. A choice made on the
 * draft wins until the created thread carries it, so the picker never flips
 * back to "No project" between send and the move landing.
 */
export function composerProjectFolderId(input: {
  readonly pendingFolderId: ProjectLabelId | null;
  readonly threadFolderId: ProjectLabelId | null;
}): ProjectLabelId | null {
  return input.pendingFolderId ?? input.threadFolderId;
}

/** The muted tail of the chat hero greeting: " · in SOSC 14100 Mind", or nothing. */
export function heroProjectSuffix(projectName: string | null | undefined): string | null {
  const name = projectName?.trim();
  return name ? ` · in ${name}` : null;
}

/** A repository-picker item and the Cogenly projects it stands for. */
export interface RepositoryRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface RepositoryProjectGroup<Item> {
  /** The folder key, or "other" for repositories in no project. */
  readonly key: ProjectLabelKey | "other";
  readonly project: EnvironmentProjectLabel | null;
  readonly items: ReadonlyArray<Item>;
}

export const OTHER_REPOSITORIES_GROUP_KEY = "other" as const;

/**
 * Repositories grouped under the projects that hold them, alphabetically by
 * project, with repositories in no project last. A repository in several
 * projects shows under each. Items keep their incoming order within a group;
 * projects holding none of the items are left out. `onlyProject` narrows to
 * one project's group.
 */
export function groupRepositoriesByProject<Item>(input: {
  readonly items: ReadonlyArray<Item>;
  readonly refsOf: (item: Item) => ReadonlyArray<RepositoryRef>;
  /** Folders, alphabetical (as the directory holds them). */
  readonly projects: ReadonlyArray<EnvironmentProjectLabel>;
  readonly onlyProject?: ProjectLabelKey | null;
  readonly leadProject?: ProjectLabelKey | null;
}): RepositoryProjectGroup<Item>[] {
  const memberKeys = new Map<string, ProjectLabelKey[]>();
  for (const project of input.projects) {
    for (const copy of projectLabelCopies(project)) {
      for (const repositoryId of copy.label.repositoryIds) {
        const key = `${copy.environmentId}:${repositoryId}`;
        const keys = memberKeys.get(key);
        if (keys) keys.push(project.key);
        else memberKeys.set(key, [project.key]);
      }
    }
  }
  const itemsByProject = new Map<ProjectLabelKey, Item[]>();
  const other: Item[] = [];
  for (const item of input.items) {
    const projectKeys = new Set<ProjectLabelKey>();
    for (const ref of input.refsOf(item)) {
      for (const key of memberKeys.get(`${ref.environmentId}:${ref.projectId}`) ?? []) {
        projectKeys.add(key);
      }
    }
    if (projectKeys.size === 0) {
      other.push(item);
      continue;
    }
    for (const key of projectKeys) {
      const items = itemsByProject.get(key);
      if (items) items.push(item);
      else itemsByProject.set(key, [item]);
    }
  }
  if (input.onlyProject) {
    const project = input.projects.find((entry) => entry.key === input.onlyProject);
    return project
      ? [{ key: project.key, project, items: itemsByProject.get(project.key) ?? [] }]
      : [];
  }
  const groups: RepositoryProjectGroup<Item>[] = [];
  for (const project of input.projects) {
    const items = itemsByProject.get(project.key);
    if (!items) continue;
    if (project.key === input.leadProject) groups.unshift({ key: project.key, project, items });
    else groups.push({ key: project.key, project, items });
  }
  if (other.length > 0) {
    groups.push({ key: OTHER_REPOSITORIES_GROUP_KEY, project: null, items: other });
  }
  return groups;
}

/** Whether `project` links the repository, as the repository's own machine has the project. */
export function projectHoldsRepository(
  project: EnvironmentProjectLabel,
  repository: RepositoryRef,
): boolean {
  return (
    projectLabelOn(project, repository.environmentId)?.label.repositoryIds.includes(
      repository.projectId,
    ) === true
  );
}

function holdsRepository(project: EnvironmentProjectLabel, refs: ReadonlyArray<RepositoryRef>) {
  return refs.some((ref) => projectHoldsRepository(project, ref));
}

/** Whether a repository belongs to `project`, or with none, to no project of `projects`. */
function belongsTo(
  project: EnvironmentProjectLabel | null,
  projects: ReadonlyArray<EnvironmentProjectLabel>,
  refs: ReadonlyArray<RepositoryRef>,
) {
  return project === null
    ? !projects.some((candidate) => holdsRepository(candidate, refs))
    : holdsRepository(project, refs);
}

// Data dirs that keep a `scratch` folder for threads without a project:
// Cogenly's own and T3 Code's, whose projects the T3 import brings over.
const SCRATCH_DATA_DIRS = new Set([".cogenly", ".t3"]);

const pathSegments = (path: string) => path.split(/[\\/]/).filter(Boolean);

function isSameOrInside(path: string, folder: string) {
  return (
    path === folder ||
    path.startsWith(folder.endsWith("/") || folder.endsWith("\\") ? folder : `${folder}/`) ||
    path.startsWith(`${folder}\\`)
  );
}

/**
 * Whether a project can be listed as a repository in a repository picker. Not
 * the machine's Scratch ("No project") home, nor anything inside a Scratch
 * folder (its per-thread folders, a T3 Code import's old Scratch), nor the
 * home folder the data dir sits in. "No repository" is the way into Scratch.
 */
export function isPickableRepository(
  project: { readonly workspaceRoot: string; readonly isScratch?: boolean | undefined },
  scratchWorkspaceRoot: string | null | undefined,
): boolean {
  if (project.isScratch === true) return false;
  const root = normalizeProjectPathForComparison(project.workspaceRoot);
  const segments = pathSegments(root);
  for (let index = 0; index < segments.length - 1; index++) {
    if (SCRATCH_DATA_DIRS.has(segments[index]!) && segments[index + 1] === "scratch") return false;
  }
  if (scratchWorkspaceRoot == null) return true;
  const scratch = normalizeProjectPathForComparison(scratchWorkspaceRoot);
  if (isSameOrInside(root, scratch)) return false;
  // Scratch is `<data dir>/scratch`; a hidden data dir sits in the home
  // folder, and a project rooted there (or above it) is not a repository.
  const scratchSegments = pathSegments(scratch);
  const dataDir = scratchSegments.at(-2);
  if (dataDir?.startsWith(".") && segments.length <= scratchSegments.length - 2) {
    return !scratchSegments
      .slice(0, segments.length)
      .every((segment, index) => segment === segments[index]);
  }
  return true;
}

/**
 * The repository a Work draft moves to when its project is picked: the
 * current one while it belongs to the project, else the project's most
 * recently active one (the first on a tie). A null project ("No project")
 * picks among the repositories in no project of `projects`. Null when there
 * is none, and Work runs in the project folder instead.
 */
export function projectDefaultRepository<Item>(input: {
  readonly items: ReadonlyArray<Item>;
  readonly refsOf: (item: Item) => ReadonlyArray<RepositoryRef>;
  readonly project: EnvironmentProjectLabel | null;
  /** Every known project; only read for a null project. */
  readonly projects?: ReadonlyArray<EnvironmentProjectLabel>;
  readonly isCurrent: (item: Item) => boolean;
  /** Latest thread activity in the repository, as epoch ms; -Infinity when none. */
  readonly lastActiveAt: (item: Item) => number;
}): Item | null {
  let best: Item | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  const projects = input.projects ?? [];
  for (const item of input.items) {
    if (!belongsTo(input.project, projects, input.refsOf(item))) continue;
    if (input.isCurrent(item)) return item;
    const at = input.lastActiveAt(item);
    if (best === null || at > bestAt) {
      best = item;
      bestAt = at;
    }
  }
  return best;
}

/**
 * What a Work draft's repository becomes when `project` is picked for it: the
 * current one while the project links it, else the project's only repository,
 * else none picked yet ("Choose a repository") when it links several, or Work
 * in the project's folder when it links none. A repository from outside the
 * project never stays.
 */
export type ProjectSwitchRepository<Item> =
  | { readonly kind: "keep" }
  | { readonly kind: "select"; readonly item: Item }
  | { readonly kind: "choose" }
  | { readonly kind: "project-folder" };

export function projectSwitchRepository<Item>(input: {
  readonly project: EnvironmentProjectLabel;
  /** The draft's repository; null for Work without one. */
  readonly current: RepositoryRef | null;
  /** The repositories the draft can move to now. */
  readonly items: ReadonlyArray<Item>;
  readonly refsOf: (item: Item) => ReadonlyArray<RepositoryRef>;
}): ProjectSwitchRepository<Item> {
  const { project } = input;
  if (input.current !== null && projectHoldsRepository(project, input.current)) {
    return { kind: "keep" };
  }
  const members = input.items.filter((item) => holdsRepository(project, input.refsOf(item)));
  // Linked repositories not on any machine here yet count too: the picker clones them.
  const linked = Math.max(projectRepositoryCount(project), members.length);
  if (linked === 0) return { kind: "project-folder" };
  if (linked === 1 && members.length === 1) return { kind: "select", item: members[0]! };
  return { kind: "choose" };
}

/**
 * The project a Work draft is in, given its pending pick (`pending`, with the
 * repository it was filed with) and its repository. With no pick it follows
 * its repository's project, or none. `stale` marks a pick that does not link
 * the repository, which the draft must not keep: the hero corrects it by
 * moving the repository (projectSwitchRepository), never by linking it. A
 * pick filed with this very repository is trusted while its link lands.
 */
export function draftWorkProject(input: {
  readonly pending: EnvironmentProjectLabel | null;
  readonly pendingRepositoryId: ProjectId | null | undefined;
  /** Null for Work without a repository, which any project can hold. */
  readonly repository: RepositoryRef | null;
  readonly folderByRepository: ReadonlyMap<string, EnvironmentProjectLabel>;
}): { readonly project: EnvironmentProjectLabel | null; readonly stale: boolean } {
  const { pending, repository } = input;
  if (repository === null) return { project: pending, stale: false };
  if (pending === null) {
    return {
      project:
        input.folderByRepository.get(
          scopedRepositoryKey(repository.environmentId, repository.projectId),
        ) ?? null,
      stale: false,
    };
  }
  const holds =
    projectHoldsRepository(pending, repository) ||
    input.pendingRepositoryId === repository.projectId;
  return { project: pending, stale: !holds };
}

/**
 * The project an existing Work thread names: its filing while that links its
 * repository (or it runs without one), else the repository's own project, or
 * none. A filing that left its repository behind is never shown with it.
 */
export function workThreadDisplayProject(input: {
  readonly filed: EnvironmentProjectLabel | null;
  /** Null for Work in its project's folder. */
  readonly repository: RepositoryRef | null;
  readonly folderByRepository: ReadonlyMap<string, EnvironmentProjectLabel>;
}): EnvironmentProjectLabel | null {
  const { filed, repository } = input;
  if (repository === null) return filed;
  if (filed !== null && projectHoldsRepository(filed, repository)) return filed;
  return (
    input.folderByRepository.get(
      scopedRepositoryKey(repository.environmentId, repository.projectId),
    ) ?? null
  );
}

/**
 * The project a Work draft records for its thread once it targets
 * `repository`: the draft's project, kept explicitly (also when it is the
 * repository's own, so a repository cloned or linked a moment ago never drops
 * the pick). Callers only pass a project that links the repository or is
 * linking it now (its own picker's rows). Projects sync across machines, so a
 * repository on another machine keeps the project when that machine has it
 * too. Null without a project, or when the repository's machine lacks it.
 */
export function workDraftFolderId(input: {
  readonly repository: RepositoryRef;
  readonly project: EnvironmentProjectLabel | null;
  /** Every known project, by key, to find `project` on the repository's machine. */
  readonly byKey: ReadonlyMap<ProjectLabelKey, EnvironmentProjectLabel>;
}): ProjectLabelId | null {
  const { project, repository } = input;
  if (project === null) return null;
  const entry =
    input.byKey.get(projectLabelKey(repository.environmentId, project.label.id)) ?? project;
  return projectLabelOn(entry, repository.environmentId) === null ? null : project.label.id;
}

/** The collapsed groups after toggling `groupKey`. */
export function toggleCollapsedGroup(
  collapsedKeys: ReadonlyArray<string>,
  groupKey: string,
): string[] {
  return collapsedKeys.includes(groupKey)
    ? collapsedKeys.filter((key) => key !== groupKey)
    : [...collapsedKeys, groupKey];
}

/**
 * What the Work hero's repository picker offers beside the repositories: its
 * "No repository" row, offered while Work can start without a repository and
 * checked once it does. Chats pick no repository.
 */
export interface WorkHeroLine {
  readonly projectFolderRow: "hidden" | "offered" | "selected";
  /** The row's text: in a project Work runs in the project's folder. */
  readonly projectFolderRowLabel: string;
}

export function workHeroLine(input: {
  readonly isChat: boolean;
  readonly hasProject: boolean;
  /** False while the draft sits in the no-project home. */
  readonly hasRepository: boolean;
  /** Whether this machine can host Work without a repository. */
  readonly canStartWithoutRepository: boolean;
  /** The project has several repositories and none is picked yet. */
  readonly repositoryUnchosen?: boolean;
}): WorkHeroLine {
  const projectFolderRowLabel = input.hasProject
    ? "No repository (project folder)"
    : "No repository";
  if (input.isChat) return { projectFolderRow: "hidden", projectFolderRowLabel };
  if (input.repositoryUnchosen === true)
    return { projectFolderRow: "offered", projectFolderRowLabel };
  if (!input.hasRepository) return { projectFolderRow: "selected", projectFolderRowLabel };
  return {
    projectFolderRow: input.canStartWithoutRepository ? "offered" : "hidden",
    projectFolderRowLabel,
  };
}

/** One half of the Work hero's breadcrumb; a placeholder reads muted, with no icon. */
export interface WorkHeroCrumb {
  readonly text: string;
  readonly placeholder: boolean;
}

/**
 * The Work hero's sentence, "What should we build in <project> / <repository>?",
 * shared by the new-Work screen and an unwritten Work thread. Both halves are
 * always named: "No project" without a project, and without a repository
 * "project folder" in a project or "no repository" outside one.
 */
export function workHeroBreadcrumb(input: {
  readonly projectName: string | null;
  /** Null while the repository is still unknown here. */
  readonly repositoryName: string | null;
  /** False for Work in the no-project home, which runs without a repository. */
  readonly hasRepository: boolean;
  /** The project has several repositories and none is picked yet. */
  readonly repositoryUnchosen?: boolean;
}): {
  readonly project: WorkHeroCrumb;
  readonly repository: WorkHeroCrumb;
  readonly label: string;
} {
  const projectName = input.projectName?.trim() || null;
  const project: WorkHeroCrumb = projectName
    ? { text: projectName, placeholder: false }
    : { text: "No project", placeholder: true };
  const repository: WorkHeroCrumb = input.repositoryUnchosen
    ? { text: "Choose a repository", placeholder: true }
    : !input.hasRepository
      ? { text: projectName ? "project folder" : "no repository", placeholder: true }
      : input.repositoryName
        ? { text: input.repositoryName, placeholder: false }
        : { text: "a repository", placeholder: true };
  return {
    project,
    repository,
    label: `What should we build in ${project.text} / ${repository.text}?`,
  };
}

/**
 * How a thread or repository names its project (folder) outside the Projects
 * page: the sidebar row subtext, the composer's project picker, the hero line
 * and the repository picker's project groups.
 */
import type { EnvironmentId, ProjectId, ProjectLabelId } from "@t3tools/contracts";

import {
  projectLabelKey,
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
    for (const repositoryId of project.label.repositoryIds) {
      const key = `${project.environmentId}:${repositoryId}`;
      const keys = memberKeys.get(key);
      if (keys) keys.push(project.key);
      else memberKeys.set(key, [project.key]);
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

function holdsRepository(project: EnvironmentProjectLabel, refs: ReadonlyArray<RepositoryRef>) {
  return refs.some(
    (ref) =>
      ref.environmentId === project.environmentId &&
      project.label.repositoryIds.includes(ref.projectId),
  );
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

/**
 * The repositories the Work hero's repository picker lists: the ones
 * `project` holds (on its machine), or without a project the ones no project
 * holds. Picking a repository never changes the project. Order is kept.
 */
export function repositoriesInProject<Item>(input: {
  readonly items: ReadonlyArray<Item>;
  readonly refsOf: (item: Item) => ReadonlyArray<RepositoryRef>;
  readonly project: EnvironmentProjectLabel | null;
  /** Every known project, to tell which repositories are in none. */
  readonly projects: ReadonlyArray<EnvironmentProjectLabel>;
}): Item[] {
  return input.items.filter((item) => belongsTo(input.project, input.projects, input.refsOf(item)));
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
 * The project a Work draft records for its thread once it targets
 * `repository`: none when that is the repository's own project, which Work
 * follows anyway, else `project` while it is on the repository's machine.
 */
export function workDraftFolderId(input: {
  readonly repository: RepositoryRef;
  readonly project: EnvironmentProjectLabel | null;
  readonly folderByRepository: ReadonlyMap<string, EnvironmentProjectLabel>;
}): ProjectLabelId | null {
  const { project, repository } = input;
  if (project === null || project.environmentId !== repository.environmentId) return null;
  const own = input.folderByRepository.get(
    scopedRepositoryKey(repository.environmentId, repository.projectId),
  );
  return own?.key === project.key ? null : project.label.id;
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
}): WorkHeroLine {
  const projectFolderRowLabel = input.hasProject
    ? "No repository (project folder)"
    : "No repository";
  if (input.isChat) return { projectFolderRow: "hidden", projectFolderRowLabel };
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
}): {
  readonly project: WorkHeroCrumb;
  readonly repository: WorkHeroCrumb;
  readonly label: string;
} {
  const projectName = input.projectName?.trim() || null;
  const project: WorkHeroCrumb = projectName
    ? { text: projectName, placeholder: false }
    : { text: "No project", placeholder: true };
  const repository: WorkHeroCrumb = !input.hasRepository
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

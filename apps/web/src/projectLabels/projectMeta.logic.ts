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

/**
 * The repository a Work draft moves to when its project is picked: the
 * current one while the project holds it, else the project's most recently
 * active one (the first on a tie). Null when the project holds none, and the
 * draft keeps its repository.
 */
export function projectDefaultRepository<Item>(input: {
  readonly items: ReadonlyArray<Item>;
  readonly refsOf: (item: Item) => ReadonlyArray<RepositoryRef>;
  readonly project: EnvironmentProjectLabel;
  readonly isCurrent: (item: Item) => boolean;
  /** Latest thread activity in the repository, as epoch ms; -Infinity when none. */
  readonly lastActiveAt: (item: Item) => number;
}): Item | null {
  let best: Item | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const item of input.items) {
    if (!holdsRepository(input.project, input.refsOf(item))) continue;
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

/**
 * Whether a repository-picker group shows its repositories. Groups start
 * open; one the user collapsed stays shut until a search matches inside it.
 */
export function isRepositoryGroupOpen(input: {
  readonly groupKey: string;
  readonly collapsedKeys: ReadonlyArray<string>;
  /** True while the search has text; a matching group then opens on its own. */
  readonly searching: boolean;
  readonly hasMatches: boolean;
}): boolean {
  if (input.searching) return input.hasMatches;
  return !input.collapsedKeys.includes(input.groupKey);
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
 * The line under the Work hero's heading, by what the draft has:
 * - `repository`: a project and a repository ("in <repo> · or just the project folder");
 * - `project-folder`: a project, no repository ("in the project folder · pick a repository…");
 * - `pick-project`: a repository, no project ("in a project… · or start without a repository");
 * - `pick-either`: neither ("in a project… · in a repository…").
 * Chats have no line.
 */
export type WorkHeroSubline =
  | "none"
  | "repository"
  | "project-folder"
  | "pick-project"
  | "pick-either";

export interface WorkHeroLine {
  readonly subline: WorkHeroSubline;
  /**
   * The repository picker's "No repository (project folder)" row: offered in
   * a project when Work can start without a repository, checked once it does.
   */
  readonly projectFolderRow: "hidden" | "offered" | "selected";
}

export function workHeroLine(input: {
  readonly isChat: boolean;
  readonly hasProject: boolean;
  /** False while the draft sits in the no-project home. */
  readonly hasRepository: boolean;
  /** Whether this machine can host Work without a repository. */
  readonly canStartWithoutRepository: boolean;
}): WorkHeroLine {
  if (input.isChat) return { subline: "none", projectFolderRow: "hidden" };
  if (input.hasProject) {
    return input.hasRepository
      ? {
          subline: "repository",
          projectFolderRow: input.canStartWithoutRepository ? "offered" : "hidden",
        }
      : { subline: "project-folder", projectFolderRow: "selected" };
  }
  return {
    subline: input.hasRepository ? "pick-project" : "pick-either",
    projectFolderRow: "hidden",
  };
}

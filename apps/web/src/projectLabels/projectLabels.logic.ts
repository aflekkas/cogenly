/**
 * Projects are folders (`ProjectLabel` in code). A folder holds many
 * repositories (Cogenly projects) and threads; each repository and thread is
 * in at most one. Work without an explicit folder follows its repository's.
 * Folders are context only and never grant access. They live per
 * environment, so every key here is scoped by environment id.
 */
import type {
  EnvironmentId,
  ProjectId,
  ProjectLabelId,
  ProjectLabelWithRepositories,
} from "@t3tools/contracts";

import { PROJECT_ICON_COLORS } from "../projectIconColors";

export type ProjectLabelKey = `${string}:${string}`;

export interface EnvironmentProjectLabel {
  readonly key: ProjectLabelKey;
  readonly environmentId: EnvironmentId;
  readonly label: ProjectLabelWithRepositories;
}

export function projectLabelKey(
  environmentId: EnvironmentId | string,
  labelId: ProjectLabelId | string,
): ProjectLabelKey {
  return `${environmentId}:${labelId}`;
}

export function scopedRepositoryKey(
  environmentId: EnvironmentId | string,
  repositoryId: ProjectId | string,
): string {
  return `${environmentId}:${repositoryId}`;
}

/** The palette repositories already use for icons; a project stores the value name. */
export const PROJECT_LABEL_COLORS = PROJECT_ICON_COLORS;
const DEFAULT_PROJECT_LABEL_COLOR = "gray";
const KNOWN_COLORS = new Set<string>(PROJECT_LABEL_COLORS.map((color) => color.value));

/** CSS color for a stored label color; unknown or missing values read as gray. */
export function projectLabelColorValue(color: string | undefined): string {
  const name = color !== undefined && KNOWN_COLORS.has(color) ? color : DEFAULT_PROJECT_LABEL_COLOR;
  return `var(--color-${name}-500)`;
}

export function sortProjectLabels<T extends { readonly label: { readonly name: string } }>(
  labels: ReadonlyArray<T>,
): T[] {
  return labels.toSorted((left, right) =>
    left.label.name.localeCompare(right.label.name, undefined, { sensitivity: "base" }),
  );
}

/** The folder a thread is filed in, as the server resolved it (explicit, else its repository's). */
export function threadProjectFolderId(thread: {
  readonly source: { readonly projectFolderId?: ProjectLabelId | null | undefined };
}): ProjectLabelId | null {
  return thread.source.projectFolderId ?? null;
}

export interface RepositoryFolderMove {
  /** The folder the repository is in now, if any. */
  readonly from: EnvironmentProjectLabel | null;
  /** True when adding it here takes it out of another folder, which needs a confirm. */
  readonly needsConfirm: boolean;
}

/** What adding a repository to `targetKey` would do, given where it is filed now. */
export function repositoryFolderMove(
  targetKey: ProjectLabelKey,
  current: EnvironmentProjectLabel | undefined,
): RepositoryFolderMove {
  if (current === undefined) return { from: null, needsConfirm: false };
  return { from: current, needsConfirm: current.key !== targetKey };
}

export interface ThreadFolderState {
  /** The folder the thread is in now; null when unfiled or the folder is unknown here. */
  readonly current: EnvironmentProjectLabel | null;
  /**
   * True when Work sits in its repository's folder, so "Remove from folder"
   * would leave it where it is. Moving it elsewhere still works.
   */
  readonly viaRepository: boolean;
  /** Folders on the thread's environment it can move to, alphabetical. */
  readonly options: ReadonlyArray<EnvironmentProjectLabel>;
}

/** Where a thread is filed and where it could go, for move menus. */
export function threadFolderState(
  thread: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly source: { readonly projectFolderId?: ProjectLabelId | null | undefined };
  },
  isWork: boolean,
  directory: {
    readonly labels: ReadonlyArray<EnvironmentProjectLabel>;
    readonly byKey: ReadonlyMap<ProjectLabelKey, EnvironmentProjectLabel>;
    readonly folderByRepository: ReadonlyMap<string, EnvironmentProjectLabel>;
  },
): ThreadFolderState {
  const folderId = threadProjectFolderId(thread);
  const current =
    folderId === null
      ? null
      : (directory.byKey.get(projectLabelKey(thread.environmentId, folderId)) ?? null);
  const repositoryFolder = isWork
    ? directory.folderByRepository.get(scopedRepositoryKey(thread.environmentId, thread.projectId))
    : undefined;
  return {
    current,
    viaRepository: current !== null && repositoryFolder?.key === current.key,
    options: directory.labels.filter((entry) => entry.environmentId === thread.environmentId),
  };
}

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

import {
  normalizeProjectColor,
  PROJECT_ICON_COLORS,
  type ProjectPaletteColor,
} from "../projectIconColors";

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
const DEFAULT_PROJECT_LABEL_COLOR: ProjectPaletteColor = "gray";

/**
 * The palette color a stored label color shows as. A retired hue reads as its
 * nearest remaining one; unknown or missing values read as gray.
 */
export function projectLabelPaletteColor(color: string | null | undefined): ProjectPaletteColor {
  return normalizeProjectColor(color) ?? DEFAULT_PROJECT_LABEL_COLOR;
}

/** CSS color for a stored label color. */
export function projectLabelColorValue(color: string | undefined): string {
  return `var(--color-${projectLabelPaletteColor(color)}-500)`;
}

export function sortProjectLabels<T extends { readonly label: { readonly name: string } }>(
  labels: ReadonlyArray<T>,
): T[] {
  return labels.toSorted((left, right) =>
    left.label.name.localeCompare(right.label.name, undefined, { sensitivity: "base" }),
  );
}

/** Archived projects keep their threads but leave every picker and move menu. */
export function isProjectLabelArchived(label: {
  readonly archivedAt?: string | undefined;
}): boolean {
  return label.archivedAt !== undefined;
}

/** Folders split into the ones pickers offer and the archived ones, each keeping its order. */
export function partitionArchivedProjectLabels<
  T extends { readonly label: { readonly archivedAt?: string | undefined } },
>(labels: ReadonlyArray<T>): { readonly active: T[]; readonly archived: T[] } {
  const active: T[] = [];
  const archived: T[] = [];
  for (const entry of labels) (isProjectLabelArchived(entry.label) ? archived : active).push(entry);
  return { active, archived };
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

export type ProjectFolderSource = "explicit" | "repository";

interface FolderedThread {
  readonly environmentId: EnvironmentId;
  readonly source: {
    readonly projectFolderId?: ProjectLabelId | null | undefined;
    readonly projectFolderSource?: ProjectFolderSource | null | undefined;
  };
}

export interface ThreadFolderState {
  /** The folder the thread is in now; null when unfiled or the folder is unknown here. */
  readonly current: EnvironmentProjectLabel | null;
  /** How it got there: moved by hand, or Work following its repository. */
  readonly source: ProjectFolderSource | null;
  /** Work in its repository's folder. It can move elsewhere, but not be removed. */
  readonly viaRepository: boolean;
  /** Only an explicit filing can be removed; removing restores the repository default. */
  readonly removable: boolean;
  /** Active folders on the thread's environment it can move to, alphabetical. */
  readonly options: ReadonlyArray<EnvironmentProjectLabel>;
}

/** Where a thread is filed, how, and where it could go, for move menus. */
export function threadFolderState(
  thread: FolderedThread,
  directory: {
    readonly labels: ReadonlyArray<EnvironmentProjectLabel>;
    readonly byKey: ReadonlyMap<ProjectLabelKey, EnvironmentProjectLabel>;
  },
): ThreadFolderState {
  const folderId = threadProjectFolderId(thread);
  const current =
    folderId === null
      ? null
      : (directory.byKey.get(projectLabelKey(thread.environmentId, folderId)) ?? null);
  const source = current === null ? null : (thread.source.projectFolderSource ?? null);
  return {
    current,
    source,
    viaRepository: source === "repository",
    removable: source === "explicit",
    // An archived folder is never offered, though a thread already in one
    // still names it as `current`.
    options: directory.labels.filter(
      (entry) =>
        entry.environmentId === thread.environmentId && !isProjectLabelArchived(entry.label),
    ),
  };
}

/**
 * The project a Work card names: an explicit filing, else the project its
 * repository is in now. The repository's project is read from the live
 * directory because a thread's server-resolved folder is only refreshed with
 * the thread, so it lags a repository being added to or taken out of a project.
 */
export function workThreadFolder(
  thread: FolderedThread & { readonly projectId: ProjectId },
  directory: {
    readonly byKey: ReadonlyMap<ProjectLabelKey, EnvironmentProjectLabel>;
    readonly folderByRepository: ReadonlyMap<string, EnvironmentProjectLabel>;
  },
): EnvironmentProjectLabel | null {
  const folderId = threadProjectFolderId(thread);
  const filed =
    folderId === null
      ? null
      : (directory.byKey.get(projectLabelKey(thread.environmentId, folderId)) ?? null);
  const source = thread.source.projectFolderSource ?? null;
  if (source === "explicit") return filed;
  const repositoryFolder =
    directory.folderByRepository.get(scopedRepositoryKey(thread.environmentId, thread.projectId)) ??
    null;
  // An older server sends no source, so a folder it resolved may be explicit.
  return source === "repository" || filed === null ? repositoryFolder : filed;
}

/** A filing to put back: the folder and how the thread was in it. */
export interface PriorFiling {
  readonly id: ProjectLabelId;
  readonly name: string;
  readonly source: ProjectFolderSource | null;
}

/**
 * The folder id an Undo sends to restore `prior` exactly. A repository-derived
 * or unfiled thread gets null (no explicit filing), so it keeps following its
 * repository; an explicit filing gets its folder back.
 */
export function undoFolderId(prior: PriorFiling | null): ProjectLabelId | null {
  return prior?.source === "explicit" ? prior.id : null;
}

/** The prior filing to remember before a move, from the thread's folder state. */
export function priorFiling(state: ThreadFolderState): PriorFiling | null {
  return state.current
    ? { id: state.current.label.id, name: state.current.label.name, source: state.source }
    : null;
}

/** The parts of a thread that decide how it goes into a project. */
export interface ProjectFolderChangeThread {
  readonly source: {
    readonly surface?: string | undefined;
    readonly agent?: { readonly role: string } | undefined;
  };
  /** Null until the thread's first turn. */
  readonly latestRun: unknown;
}

/** True for a chat with turns: the server refuses to re-parent it, so it forks. */
export function threadForksIntoProjects(thread: ProjectFolderChangeThread): boolean {
  return (
    (thread.source.surface ?? "chat") === "chat" &&
    thread.source.agent?.role !== "work" &&
    thread.latestRun !== null
  );
}

/**
 * How putting a thread in `folderId` happens. A chat with turns is forked
 * into the project (the original stays where it is) because its history ran
 * in another directory; a turnless chat or Work files in place, and taking a
 * thread out of a project is always a move.
 */
export function projectFolderChangeKind(
  thread: ProjectFolderChangeThread,
  folderId: ProjectLabelId | null,
): "move" | "fork" {
  return folderId !== null && threadForksIntoProjects(thread) ? "fork" : "move";
}

/**
 * Each folder's own project chat, as `environmentId:threadId`. That thread
 * lives on the project's page, so the Chats list and folder contents skip it.
 */
export function projectChatThreadKeys(
  labels: ReadonlyArray<Pick<EnvironmentProjectLabel, "environmentId" | "label">>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const entry of labels) {
    const threadId = entry.label.projectChatThreadId;
    if (threadId) keys.add(`${entry.environmentId}:${threadId}`);
  }
  return keys;
}

/** `threads` without the project chats in `keys` (see `projectChatThreadKeys`). */
export function withoutProjectChats<
  T extends { readonly environmentId: string; readonly id: string },
>(threads: ReadonlyArray<T>, keys: ReadonlySet<string>): T[] {
  if (keys.size === 0) return [...threads];
  return threads.filter((thread) => !keys.has(`${thread.environmentId}:${thread.id}`));
}

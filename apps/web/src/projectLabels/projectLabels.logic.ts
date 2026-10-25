/**
 * Projects are folders (`ProjectLabel` in code). A folder holds many
 * repositories (Cogenly projects) and threads; each repository and thread is
 * in at most one. Work without an explicit folder follows its repository's.
 * Folders are context only and never grant access. Each machine stores its
 * own copy, and paired machines sync a project under one id, so the client
 * shows one entry per id (`unifyProjectLabels`) while repository and thread
 * keys stay scoped by environment id.
 */
import {
  isRemoteRepositoryPlaceholder,
  projectHomeOwner,
  REMOTE_REPOSITORY_ID_PREFIX,
  type EnvironmentId,
  type ProjectId,
  type ProjectLabelId,
  type ProjectLabelRepositoryLink,
  type ProjectLabelWithRepositories,
  type ProjectSourceLink,
} from "@cogenly/contracts";

import {
  normalizeProjectColor,
  PROJECT_ICON_COLORS,
  type ProjectPaletteColor,
} from "../projectIconColors";

export type ProjectLabelKey = `${string}:${string}`;

/** One machine's copy of a project. */
export interface ProjectLabelCopy {
  readonly environmentId: EnvironmentId;
  readonly label: ProjectLabelWithRepositories;
}

export interface EnvironmentProjectLabel {
  readonly key: ProjectLabelKey;
  /** The machine whose copy speaks for the project: the primary one when it has it. */
  readonly environmentId: EnvironmentId;
  /**
   * The project as one: `environmentId`'s copy, named as most recently edited
   * anywhere, linking every repository any machine links.
   */
  readonly label: ProjectLabelWithRepositories;
  /** Every connected machine's copy, `environmentId`'s first. Absent when only it has one. */
  readonly copies?: ReadonlyArray<ProjectLabelCopy>;
}

/** Every connected machine's copy of `entry`, its own machine's first. */
export function projectLabelCopies(
  entry: EnvironmentProjectLabel,
): ReadonlyArray<ProjectLabelCopy> {
  return entry.copies ?? [{ environmentId: entry.environmentId, label: entry.label }];
}

/** The machines that have `entry`, its own first. */
export function projectLabelEnvironmentIds(
  entry: EnvironmentProjectLabel,
): ReadonlyArray<EnvironmentId> {
  return projectLabelCopies(entry).map((copy) => copy.environmentId);
}

/**
 * `entry` as `environmentId` has it: that machine's own copy (its repository
 * ids are that machine's), under the same key. Null when the machine lacks it.
 */
export function projectLabelOn(
  entry: EnvironmentProjectLabel,
  environmentId: EnvironmentId,
): EnvironmentProjectLabel | null {
  const copy = projectLabelCopies(entry).find(
    (candidate) => candidate.environmentId === environmentId,
  );
  if (copy === undefined) return null;
  if (entry.copies === undefined) return entry;
  return { key: entry.key, environmentId, label: copy.label, copies: entry.copies };
}

/** The projects `environmentId` has, each as that machine has it. */
export function projectLabelsOn(
  entries: ReadonlyArray<EnvironmentProjectLabel>,
  environmentId: EnvironmentId,
): EnvironmentProjectLabel[] {
  return entries.flatMap((entry) => projectLabelOn(entry, environmentId) ?? []);
}

/**
 * How many repositories the project links on any machine: one per remote,
 * plus each machine's links that have none.
 */
export function projectRepositoryCount(entry: EnvironmentProjectLabel): number {
  const keys = new Set<string>();
  for (const copy of projectLabelCopies(entry)) {
    for (const link of copyRepositoryLinks(copy.label)) {
      const remote = linkRemote(link);
      keys.add(remote === null ? `${copy.environmentId}:${link.repositoryId}` : `remote:${remote}`);
    }
  }
  return keys.size;
}

function copyRepositoryLinks(label: ProjectLabelWithRepositories) {
  return (
    label.repositories ??
    label.repositoryIds.map((repositoryId): ProjectLabelRepositoryLink => ({
      repositoryId,
      remote: null,
      directoryName: null,
    }))
  );
}

function linkRemote(link: ProjectLabelRepositoryLink): string | null {
  const remote =
    link.remote ??
    (isRemoteRepositoryPlaceholder(link.repositoryId)
      ? link.repositoryId.slice(REMOTE_REPOSITORY_ID_PREFIX.length) || null
      : null);
  return remote === null ? null : remote.toLowerCase();
}

/**
 * The project as one, from its copies (the speaking machine's first): the
 * name, colour and other synced fields of the most recently edited copy, and
 * the speaking copy's links plus any remote only another machine links yet,
 * which reads as not cloned here, as the server would show it once synced.
 */
function mergeProjectLabelCopies(
  copies: ReadonlyArray<ProjectLabelCopy>,
): ProjectLabelWithRepositories {
  const own = copies[0]!.label;
  if (copies.length === 1) return own;
  const newest = copies.reduce(
    (latest, copy) => (copy.label.updatedAt > latest.updatedAt ? copy.label : latest),
    own,
  );
  const ownLinks = copyRepositoryLinks(own);
  const held = new Set(ownLinks.map(linkRemote).filter((remote) => remote !== null));
  const arrived: ProjectLabelRepositoryLink[] = [];
  for (const copy of copies.slice(1)) {
    for (const link of copyRepositoryLinks(copy.label)) {
      const remote = linkRemote(link);
      if (remote === null || held.has(remote)) continue;
      held.add(remote);
      arrived.push({
        repositoryId: `${REMOTE_REPOSITORY_ID_PREFIX}${link.remote ?? remote}` as ProjectId,
        remote: link.remote ?? remote,
        directoryName: link.directoryName,
        checkout: "not_cloned",
        ...(link.iconPath === undefined ? {} : { iconPath: link.iconPath }),
      });
    }
  }
  const possibleDuplicateIds = [
    ...new Set(copies.flatMap((copy) => copy.label.possibleDuplicateIds ?? [])),
  ];
  const {
    color: _color,
    description: _description,
    archivedAt: _archivedAt,
    possibleDuplicateIds: _possibleDuplicateIds,
    ...base
  } = own;
  return {
    ...base,
    name: newest.name,
    ...(newest.color === undefined ? {} : { color: newest.color }),
    ...(newest.description === undefined ? {} : { description: newest.description }),
    ...(newest.archivedAt === undefined ? {} : { archivedAt: newest.archivedAt }),
    instructions: newest.instructions,
    sourceLinks: newest.sourceLinks,
    updatedAt: newest.updatedAt,
    ...(arrived.length > 0 || own.repositories !== undefined
      ? { repositories: [...ownLinks, ...arrived] }
      : {}),
    projectChatThreadId:
      own.projectChatThreadId ??
      copies.find((copy) => copy.label.projectChatThreadId !== null)?.label.projectChatThreadId ??
      null,
    threadCount: Math.max(...copies.map((copy) => copy.label.threadCount)),
    ...(possibleDuplicateIds.length > 0 ? { possibleDuplicateIds } : {}),
  };
}

export interface UnifiedProjectLabels {
  /** One entry per project id, alphabetical. */
  readonly labels: ReadonlyArray<EnvironmentProjectLabel>;
  /** Every machine's `projectLabelKey` for a project → its one entry. */
  readonly byKey: ReadonlyMap<ProjectLabelKey, EnvironmentProjectLabel>;
  /** `environmentId:repositoryId` → the one entry holding that machine's repository. */
  readonly folderByRepository: ReadonlyMap<string, EnvironmentProjectLabel>;
}

/**
 * One entry per project across machines. Paired machines sync a project
 * under one id, so copies with the same id are the same project; the first
 * machine listed that has it speaks for it. Same-name projects with
 * different ids stay apart (the server flags them as possible duplicates).
 */
export function unifyProjectLabels(
  perEnvironment: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly labels: ReadonlyArray<ProjectLabelWithRepositories>;
  }>,
): UnifiedProjectLabels {
  const copiesById = new Map<string, ProjectLabelCopy[]>();
  for (const { environmentId, labels } of perEnvironment) {
    for (const label of labels) {
      const copies = copiesById.get(label.id);
      if (copies === undefined) copiesById.set(label.id, [{ environmentId, label }]);
      else if (!copies.some((copy) => copy.environmentId === environmentId))
        copies.push({ environmentId, label });
    }
  }
  const byKey = new Map<ProjectLabelKey, EnvironmentProjectLabel>();
  const folderByRepository = new Map<string, EnvironmentProjectLabel>();
  const labels: EnvironmentProjectLabel[] = [];
  for (const copies of copiesById.values()) {
    const own = copies[0]!;
    const entry: EnvironmentProjectLabel = {
      key: projectLabelKey(own.environmentId, own.label.id),
      environmentId: own.environmentId,
      label: mergeProjectLabelCopies(copies),
      ...(copies.length > 1 ? { copies } : {}),
    };
    labels.push(entry);
    for (const copy of copies) {
      byKey.set(projectLabelKey(copy.environmentId, copy.label.id), entry);
    }
  }
  const sorted = sortProjectLabels(labels);
  // Alphabetical, so a repository two projects claim mid-sync resolves as before.
  for (const entry of sorted) {
    for (const copy of projectLabelCopies(entry)) {
      for (const repositoryId of copy.label.repositoryIds) {
        folderByRepository.set(scopedRepositoryKey(copy.environmentId, repositoryId), entry);
      }
    }
  }
  return { labels: sorted, byKey, folderByRepository };
}

/**
 * Two projects created apart under the same name, which the server flags as
 * possibly one. Merging moves `from` into `into`, the older one.
 */
export interface PossibleDuplicateProjects {
  readonly key: string;
  readonly into: EnvironmentProjectLabel;
  readonly from: EnvironmentProjectLabel;
  /** A machine that has both, which runs the merge; null while none does yet. */
  readonly environmentId: EnvironmentId | null;
}

/** Every flagged pair among `entries` once, in the order the entries come. */
export function possibleDuplicateProjects(
  entries: ReadonlyArray<EnvironmentProjectLabel>,
): PossibleDuplicateProjects[] {
  const byId = new Map(entries.map((entry) => [entry.label.id as string, entry] as const));
  const seen = new Set<string>();
  const pairs: PossibleDuplicateProjects[] = [];
  for (const entry of entries) {
    for (const otherId of entry.label.possibleDuplicateIds ?? []) {
      const other = byId.get(otherId);
      if (other === undefined || other === entry) continue;
      const key = [entry.label.id, other.label.id].toSorted().join("\0");
      if (seen.has(key)) continue;
      seen.add(key);
      const entryFirst =
        entry.label.createdAt < other.label.createdAt ||
        (entry.label.createdAt === other.label.createdAt && entry.label.id < other.label.id);
      const [into, from] = entryFirst ? [entry, other] : [other, entry];
      const fromMachines = new Set(projectLabelEnvironmentIds(from));
      const shared = projectLabelEnvironmentIds(into).filter((id) => fromMachines.has(id));
      pairs.push({ key, into, from, environmentId: shared[0] ?? null });
    }
  }
  return pairs;
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

/**
 * Where a project's icon comes from: the avatar of the GitHub owner it links
 * (its home owner, so every machine shows the same one, resolved like a
 * repository's owner avatar through the `github.com/<owner>` remote), else
 * the folder in its colour. A project has no icon of its own to pick; one
 * would come first here.
 */
export function projectIconSource(label: {
  readonly sourceLinks?: ReadonlyArray<ProjectSourceLink> | undefined;
}): { readonly kind: "owner-avatar"; readonly remote: string } | { readonly kind: "folder" } {
  const owner = projectHomeOwner(label.sourceLinks ?? []);
  return owner === null
    ? { kind: "folder" }
    : { kind: "owner-avatar", remote: `github.com/${owner}` };
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

/**
 * Where a repository added from a chat's Start Work is filed: the chat's own
 * project on the chat's machine, unless it has none or that project is archived.
 */
export function chatAddRepositoryTarget(
  thread: {
    readonly environmentId: EnvironmentId;
    readonly source: { readonly projectFolderId?: ProjectLabelId | null | undefined };
  },
  byKey: ReadonlyMap<ProjectLabelKey, EnvironmentProjectLabel>,
): { readonly environmentId: EnvironmentId; readonly labelId: ProjectLabelId } | null {
  const folderId = threadProjectFolderId(thread);
  if (folderId === null) return null;
  const project = byKey.get(projectLabelKey(thread.environmentId, folderId));
  if (
    project === undefined ||
    project.environmentId !== thread.environmentId ||
    isProjectLabelArchived(project.label)
  ) {
    return null;
  }
  return { environmentId: project.environmentId, labelId: project.label.id };
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
  readonly id?: string;
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
  /** Active folders on the thread's environment, alphabetical. */
  readonly options: ReadonlyArray<EnvironmentProjectLabel>;
  /**
   * Why an option can't take the thread, by option key: a project that does
   * not include the repository it works in ("Doesn't include platform").
   * Such options are listed, disabled; a move menu never links a repository.
   */
  readonly blocked: ReadonlyMap<ProjectLabelKey, string>;
  /** Whether the thread works in a repository, so a new project could not take it either. */
  readonly inRepository: boolean;
  /** A project's own conversation: it stays in that project, so no move or new project takes it. */
  readonly projectHome: boolean;
}

/** The repository a thread works in, for move menus; null for a machine's or a project's folder. */
export interface ThreadRepository {
  readonly projectId: ProjectId;
  readonly name: string;
}

/**
 * Whether `thread` is some project's own conversation (from when each project
 * had one). It is listed with the project's chats, and stays in its project.
 */
export function isProjectChatThread(
  thread: { readonly id?: string; readonly environmentId: EnvironmentId },
  labels: ReadonlyArray<EnvironmentProjectLabel>,
): boolean {
  return projectChatHome(thread, labels) !== undefined;
}

/** The project whose own conversation `thread` is, if any. */
function projectChatHome(
  thread: { readonly id?: string; readonly environmentId: EnvironmentId },
  labels: ReadonlyArray<EnvironmentProjectLabel>,
): EnvironmentProjectLabel | undefined {
  if (thread.id === undefined) return undefined;
  return labels.find((entry) => {
    const own = projectLabelOn(entry, thread.environmentId);
    return own?.label.projectChatThreadId != null && own.label.projectChatThreadId === thread.id;
  });
}

/** Where a thread is filed, how, and where it could go, for move menus. */
export function threadFolderState(
  thread: FolderedThread,
  directory: {
    readonly labels: ReadonlyArray<EnvironmentProjectLabel>;
    readonly byKey: ReadonlyMap<ProjectLabelKey, EnvironmentProjectLabel>;
  },
  repository: ThreadRepository | null = null,
): ThreadFolderState {
  const folderId = threadProjectFolderId(thread);
  const current =
    folderId === null
      ? null
      : (directory.byKey.get(projectLabelKey(thread.environmentId, folderId)) ?? null);
  const source = current === null ? null : (thread.source.projectFolderSource ?? null);
  // A project's own conversation stays in its project: every other project is
  // listed, disabled, so the menu says why rather than showing nothing.
  const home = projectChatHome(thread, directory.labels);
  const projectHome = home !== undefined;
  // An archived folder is never offered, though a thread already in one
  // still names it as `current`.
  const options = projectLabelsOn(directory.labels, thread.environmentId).filter(
    (entry) => !isProjectLabelArchived(entry.label),
  );
  const blocked = new Map<ProjectLabelKey, string>();
  if (home !== undefined) {
    for (const entry of options)
      if (entry.key !== home.key) blocked.set(entry.key, `Stays in ${home.label.name}`);
  } else if (repository !== null) {
    for (const entry of options) {
      if (!entry.label.repositoryIds.includes(repository.projectId))
        blocked.set(entry.key, `Doesn't include ${repository.name}`);
    }
  }
  return {
    current,
    source,
    viaRepository: source === "repository",
    removable: source === "explicit" && !projectHome,
    options,
    blocked,
    inRepository: repository !== null,
    projectHome,
  };
}

/**
 * The project a Work card names: an explicit filing, else the project its
 * repository is in now. The repository's project is read from the live
 * directory because a thread's server-resolved folder is only refreshed with
 * the thread, so it lags a repository being added to or taken out of a project.
 * A filing never names a repository it does not hold: Work in a real
 * repository (`inRepository`) filed elsewhere names the repository's own
 * project, or none. Work in a project's folder keeps its filing.
 */
export function workThreadFolder(
  thread: FolderedThread & { readonly projectId: ProjectId },
  directory: {
    readonly byKey: ReadonlyMap<ProjectLabelKey, EnvironmentProjectLabel>;
    readonly folderByRepository: ReadonlyMap<string, EnvironmentProjectLabel>;
  },
  inRepository: (thread: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) => boolean = () => false,
): EnvironmentProjectLabel | null {
  const folderId = threadProjectFolderId(thread);
  const filed =
    folderId === null
      ? null
      : (directory.byKey.get(projectLabelKey(thread.environmentId, folderId)) ?? null);
  const source = thread.source.projectFolderSource ?? null;
  const repositoryFolder =
    directory.folderByRepository.get(scopedRepositoryKey(thread.environmentId, thread.projectId)) ??
    null;
  if (source === "explicit") {
    return filed !== null && filed !== repositoryFolder && inRepository(thread)
      ? repositoryFolder
      : filed;
  }
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

/**
 * True for a chat with turns. Plain moves used to fork such chats into the
 * project; they now re-home in place (the server starts a fresh provider
 * session in the project folder with a context handoff), so nothing forks
 * on a plain move. Kept for the pickers, which only need the distinction to
 * word their actions, and explicit forks still go through the
 * forkThreadToProject RPC. Always false today.
 */
export function threadForksIntoProjects(thread: ProjectFolderChangeThread): boolean {
  void thread;
  return false;
}

/**
 * How putting a thread in `folderId` happens. Every thread files in place:
 * the server re-homes the same thread, and its next turn runs in the new
 * folder. (An explicit fork remains available through the
 * forkThreadToProject RPC for callers that ask for a copy.)
 */
export function projectFolderChangeKind(
  thread: ProjectFolderChangeThread,
  folderId: ProjectLabelId | null,
): "move" | "fork" {
  void thread;
  void folderId;
  return "move";
}

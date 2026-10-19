/**
 * Projects are context tags (`ProjectLabel` in code). A project links many
 * repositories (Cogenly projects) and tags many threads; it never grants
 * access. Labels live per environment, so every key here is scoped by
 * environment id.
 */
import type {
  EnvironmentId,
  ProjectId,
  ProjectLabelId,
  ProjectLabelWithRepositories,
  ThreadId,
  ThreadProjectLabel,
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

export function scopedThreadTagKey(
  environmentId: EnvironmentId | string,
  threadId: ThreadId | string,
): string {
  return `${environmentId}:${threadId}`;
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

export interface ResolvedThreadTag {
  readonly label: ProjectLabelWithRepositories;
  readonly tag: ThreadProjectLabel;
  readonly suggested: boolean;
}

/**
 * Confirmed tags first, alphabetically; then pending suggestions, most
 * confident first. Tags whose project no longer exists are dropped.
 */
export function resolveThreadTags(
  tags: ReadonlyArray<ThreadProjectLabel>,
  labelsById: ReadonlyMap<string, ProjectLabelWithRepositories>,
): ResolvedThreadTag[] {
  const confirmed: ResolvedThreadTag[] = [];
  const suggested: ResolvedThreadTag[] = [];
  for (const tag of tags) {
    const label = labelsById.get(tag.labelId);
    if (!label) continue;
    if (tag.confirmedByUser) confirmed.push({ label, tag, suggested: false });
    else suggested.push({ label, tag, suggested: true });
  }
  confirmed.sort((left, right) =>
    left.label.name.localeCompare(right.label.name, undefined, { sensitivity: "base" }),
  );
  suggested.sort((left, right) => (right.tag.confidence ?? 0) - (left.tag.confidence ?? 0));
  return [...confirmed, ...suggested];
}

/** Header chips: at most `max` show, the rest collapse into a "+N" count. */
export function splitTagChips<T>(
  tags: ReadonlyArray<T>,
  max = 2,
): { readonly visible: ReadonlyArray<T>; readonly overflow: ReadonlyArray<T> } {
  if (tags.length <= max) return { visible: tags, overflow: [] };
  return { visible: tags.slice(0, max), overflow: tags.slice(max) };
}

/**
 * The label ids to send when the user toggles one project. The server
 * replaces the whole set and confirms every id sent, so only confirmed tags
 * carry over; sending a pending suggestion would confirm it behind the
 * user's back. Pending suggestions are dropped by an explicit edit.
 */
export function nextThreadLabelIds(
  tags: ReadonlyArray<ThreadProjectLabel>,
  labelId: ProjectLabelId,
  selected: boolean,
): ProjectLabelId[] {
  const confirmed = tags.filter((tag) => tag.confirmedByUser).map((tag) => tag.labelId);
  const without = confirmed.filter((id) => id !== labelId);
  return selected ? [...without, labelId] : without;
}

// Work sidebar ---------------------------------------------------------------

export interface ProjectTagSummary {
  readonly key: ProjectLabelKey;
  readonly name: string;
  readonly color: string | undefined;
}

/**
 * The projects a Work row shows as chips: the thread's confirmed tags plus
 * the projects linking its repository, under any of the repository's
 * checkouts. Each project once, alphabetically.
 */
export function workRowProjectTags(
  confirmedKeys: ReadonlyArray<ProjectLabelKey>,
  repositoryKeys: ReadonlyArray<string>,
  directory: {
    readonly byKey: ReadonlyMap<ProjectLabelKey, EnvironmentProjectLabel>;
    readonly projectsByRepository: ReadonlyMap<string, ReadonlyArray<EnvironmentProjectLabel>>;
  },
): ProjectTagSummary[] {
  const entries = new Map<ProjectLabelKey, EnvironmentProjectLabel>();
  for (const key of confirmedKeys) {
    const entry = directory.byKey.get(key);
    if (entry) entries.set(key, entry);
  }
  for (const repositoryKey of repositoryKeys) {
    for (const entry of directory.projectsByRepository.get(repositoryKey) ?? []) {
      entries.set(entry.key, entry);
    }
  }
  return sortProjectLabels([...entries.values()]).map((entry) => ({
    key: entry.key,
    name: entry.label.name,
    color: entry.label.color,
  }));
}

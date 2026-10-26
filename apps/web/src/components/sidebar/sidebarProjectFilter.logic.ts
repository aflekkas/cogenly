import {
  sortProjectLabels,
  type EnvironmentProjectLabel,
  type ProjectLabelKey,
} from "../../projectLabels/projectLabels.logic";

/** The filter value for items in no project (or in a project this client doesn't know). */
export const SIDEBAR_NO_PROJECT = "none";

/**
 * What a sidebar list is narrowed to: one project by its unified key (the same
 * on every machine that has it), the items in no project, or null for all.
 */
export type SidebarProjectFilter = ProjectLabelKey | typeof SIDEBAR_NO_PROJECT | null;

export interface SidebarProjectFilterOption {
  readonly value: ProjectLabelKey | typeof SIDEBAR_NO_PROJECT;
  /** Null for No project. */
  readonly project: EnvironmentProjectLabel | null;
  readonly count: number;
}

/** The filter value an item filed in `project` matches. */
export function sidebarProjectFilterValue(
  project: EnvironmentProjectLabel | null,
): ProjectLabelKey | typeof SIDEBAR_NO_PROJECT {
  return project?.key ?? SIDEBAR_NO_PROJECT;
}

/**
 * The stored filter as it applies now: a project the directory no longer has
 * (deleted, or its machine disconnected) falls back to all, so a stale filter
 * never hides the list. `byKey` maps any machine's key to the one project, so
 * a key stored from either machine resolves to the same filter.
 */
export function resolveSidebarProjectFilter(
  filter: SidebarProjectFilter,
  byKey: ReadonlyMap<ProjectLabelKey, EnvironmentProjectLabel>,
): SidebarProjectFilter {
  if (filter === null || filter === SIDEBAR_NO_PROJECT) return filter;
  return byKey.get(filter)?.key ?? null;
}

/** What an applied filter is called, for its chip and empty state; null for all. */
export function sidebarProjectFilterName(
  filter: SidebarProjectFilter,
  byKey: ReadonlyMap<ProjectLabelKey, EnvironmentProjectLabel>,
): string | null {
  if (filter === null) return null;
  if (filter === SIDEBAR_NO_PROJECT) return "No project";
  return byKey.get(filter)?.label.name ?? null;
}

/** The items `filter` keeps, in their order; the same array when it keeps all. */
export function filterBySidebarProject<T>(
  items: ReadonlyArray<T>,
  filter: SidebarProjectFilter,
  projectOf: (item: T) => EnvironmentProjectLabel | null,
): ReadonlyArray<T> {
  if (filter === null) return items;
  return items.filter((item) => sidebarProjectFilterValue(projectOf(item)) === filter);
}

/**
 * The picker's choices for one list: each project that has items in it, by
 * name, with its count, then No project when any item is in none. The current
 * filter stays listed (with 0) after its last item leaves, so the picker still
 * shows what is chosen.
 */
export function sidebarProjectFilterOptions<T>(
  items: ReadonlyArray<T>,
  projectOf: (item: T) => EnvironmentProjectLabel | null,
  current: SidebarProjectFilter,
  byKey: ReadonlyMap<ProjectLabelKey, EnvironmentProjectLabel>,
): SidebarProjectFilterOption[] {
  const counts = new Map<ProjectLabelKey, { project: EnvironmentProjectLabel; count: number }>();
  let unfiled = 0;
  for (const item of items) {
    const project = projectOf(item);
    if (project === null) {
      unfiled += 1;
      continue;
    }
    const entry = counts.get(project.key);
    if (entry) entry.count += 1;
    else counts.set(project.key, { project, count: 1 });
  }
  if (current !== null && current !== SIDEBAR_NO_PROJECT && !counts.has(current)) {
    const project = byKey.get(current);
    if (project) counts.set(project.key, { project, count: 0 });
  }
  const options: SidebarProjectFilterOption[] = sortProjectLabels(
    [...counts.values()].map((entry) => entry.project),
  ).map((project) => ({ value: project.key, project, count: counts.get(project.key)!.count }));
  if (unfiled > 0 || current === SIDEBAR_NO_PROJECT) {
    options.push({ value: SIDEBAR_NO_PROJECT, project: null, count: unfiled });
  }
  return options;
}

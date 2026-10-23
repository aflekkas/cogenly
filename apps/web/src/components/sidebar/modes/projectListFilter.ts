import { useSyncExternalStore } from "react";

/** The Projects column's filter: the active projects, or the archived ones. */
export type ProjectListFilter = "active" | "archived";

export const PROJECT_LIST_FILTER_ORDER: ReadonlyArray<ProjectListFilter> = ["active", "archived"];

let filter: ProjectListFilter = "active";
const listeners = new Set<() => void>();

export function setProjectListFilter(next: ProjectListFilter) {
  if (filter === next) return;
  filter = next;
  for (const listener of listeners) listener();
}

export function useProjectListFilter(): ProjectListFilter {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => filter,
  );
}

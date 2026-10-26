import { useSyncExternalStore } from "react";

import type { SidebarMode } from "./modes/sidebarModes.logic";
import type { SidebarProjectFilter } from "./sidebarProjectFilter.logic";

/**
 * Each sidebar list's project filter, for this session. Chats, Work and Agents
 * keep their own, as each keeps its own search and count-bar filter: a project
 * chosen in Chats never quietly narrows Work. Like the Agents list's Needs
 * attention filter it is not persisted, so a reload never opens on a list that
 * hides most of your threads.
 */
const filters = new Map<SidebarMode, SidebarProjectFilter>();
const listeners = new Set<() => void>();

export function setSidebarProjectFilter(mode: SidebarMode, next: SidebarProjectFilter) {
  if ((filters.get(mode) ?? null) === next) return;
  if (next === null) filters.delete(mode);
  else filters.set(mode, next);
  for (const listener of listeners) listener();
}

export function readSidebarProjectFilter(mode: SidebarMode): SidebarProjectFilter {
  return filters.get(mode) ?? null;
}

export function useSidebarProjectFilter(mode: SidebarMode): SidebarProjectFilter {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => readSidebarProjectFilter(mode),
  );
}

import type { SidebarThreadMode } from "../components/sidebar/modes/sidebarModes.logic";
import type { ProjectLabelKey } from "./projectLabels.logic";

export interface ProjectContents<T> {
  readonly chats: T[];
  readonly work: T[];
}

/**
 * Every chat and Work thread under the one folder it is filed in, in input
 * order. Threads in no folder, or in a folder this client does not know, have
 * no entry; nor do folders with nothing in them.
 */
export function indexProjectContents<T>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly modeOf: (thread: T) => SidebarThreadMode;
  readonly folderKeyOf: (thread: T) => ProjectLabelKey | null;
}): ReadonlyMap<ProjectLabelKey, ProjectContents<T>> {
  const index = new Map<ProjectLabelKey, { chats: T[]; work: T[] }>();
  for (const thread of input.threads) {
    const key = input.folderKeyOf(thread);
    if (key === null) continue;
    const mode = input.modeOf(thread);
    if (mode !== "chats" && mode !== "tasks") continue;
    let entry = index.get(key);
    if (!entry) {
      entry = { chats: [], work: [] };
      index.set(key, entry);
    }
    (mode === "chats" ? entry.chats : entry.work).push(thread);
  }
  return index;
}

/** How many threads a folder shows, for list counts. */
export function projectContentsCount(contents: ProjectContents<unknown> | undefined) {
  return contents ? contents.chats.length + contents.work.length : 0;
}

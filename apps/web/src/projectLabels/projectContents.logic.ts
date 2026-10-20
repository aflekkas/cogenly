import type { SidebarThreadMode } from "../components/sidebar/modes/sidebarModes.logic";
import type { ProjectLabelKey } from "./projectLabels.logic";

export interface ProjectContents<T, A> {
  readonly work: T[];
  readonly chats: T[];
  readonly agents: A[];
}

/**
 * Every thread and agent under the projects it belongs to, in input order.
 * Work belongs to its confirmed tags and the projects linking its
 * repository; chats only to their confirmed tags; agents only where
 * `agentProjectKeys` files them. Agent conversations list under their agent,
 * not as threads. Projects with nothing in them have no entry.
 */
export function indexProjectContents<T, A>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly modeOf: (thread: T) => SidebarThreadMode;
  readonly workProjectKeys: (thread: T) => ReadonlyArray<ProjectLabelKey>;
  readonly chatProjectKeys: (thread: T) => ReadonlyArray<ProjectLabelKey>;
  readonly agents: ReadonlyArray<A>;
  readonly agentProjectKeys: (agent: A) => ReadonlyArray<ProjectLabelKey>;
}): ReadonlyMap<ProjectLabelKey, ProjectContents<T, A>> {
  const index = new Map<ProjectLabelKey, { work: T[]; chats: T[]; agents: A[] }>();
  const entryFor = (key: ProjectLabelKey) => {
    let entry = index.get(key);
    if (!entry) {
      entry = { work: [], chats: [], agents: [] };
      index.set(key, entry);
    }
    return entry;
  };
  for (const thread of input.threads) {
    const mode = input.modeOf(thread);
    if (mode === "tasks") {
      for (const key of new Set(input.workProjectKeys(thread))) entryFor(key).work.push(thread);
    } else if (mode === "chats") {
      for (const key of new Set(input.chatProjectKeys(thread))) entryFor(key).chats.push(thread);
    }
  }
  for (const agent of input.agents) {
    for (const key of new Set(input.agentProjectKeys(agent))) entryFor(key).agents.push(agent);
  }
  return index;
}

/** How many items a project holds, for the sidebar's count. */
export function projectContentsCount(contents: ProjectContents<unknown, unknown> | undefined) {
  return contents ? contents.work.length + contents.chats.length + contents.agents.length : 0;
}

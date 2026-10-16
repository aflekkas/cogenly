/**
 * The sidebar lists one of three kinds of work at a time:
 *
 * - Chats: threads in an environment's scratch ("No project") project.
 * - Tasks: threads in real projects.
 * - Agents: persistent agent conversations. Background work opens from Activity.
 *
 * Every visible thread belongs to one mode, so a thread never shows twice and
 * opening one from anywhere (search, a notification, a link) can switch the
 * sidebar to the mode that lists it.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export type SidebarMode = "chats" | "tasks" | "agents";

export const SIDEBAR_MODES: ReadonlyArray<SidebarMode> = ["chats", "tasks", "agents"];

export const SIDEBAR_MODE_LABELS: Record<SidebarMode, string> = {
  chats: "Chats",
  tasks: "Tasks",
  agents: "Agents",
};

export const DEFAULT_SIDEBAR_MODE: SidebarMode = "tasks";

export function isSidebarMode(value: unknown): value is SidebarMode {
  return value === "chats" || value === "tasks" || value === "agents";
}

export function sidebarModeThreadKey(
  environmentId: EnvironmentId | string,
  threadId: ThreadId | string,
) {
  return `${environmentId}:${threadId}`;
}

/** Agents win over chats: an agent conversation in a scratch project is still an agent. */
export function classifySidebarThreadMode(input: {
  readonly isAgent: boolean;
  readonly isScratch: boolean;
}): SidebarMode {
  if (input.isAgent) return "agents";
  return input.isScratch ? "chats" : "tasks";
}

export interface SidebarModeThreadClassifier {
  /** `environmentId:threadId` of every agent conversation. */
  readonly agentThreadKeys: ReadonlySet<string>;
  /** `environmentId:projectId` of every scratch project. */
  readonly scratchProjectKeys: ReadonlySet<string>;
}

export function sidebarModeForThread(
  thread: {
    readonly environmentId: EnvironmentId | string;
    readonly id: ThreadId | string;
    readonly projectId: string;
    readonly source?: { readonly agent?: { readonly role: "conversation" | "work" } | undefined };
  },
  classifier: SidebarModeThreadClassifier,
): SidebarMode {
  return classifySidebarThreadMode({
    isAgent:
      thread.source?.agent !== undefined ||
      classifier.agentThreadKeys.has(sidebarModeThreadKey(thread.environmentId, thread.id)),
    isScratch: classifier.scratchProjectKeys.has(`${thread.environmentId}:${thread.projectId}`),
  });
}

export function filterThreadsForSidebarMode<
  T extends {
    readonly environmentId: EnvironmentId | string;
    readonly id: ThreadId | string;
    readonly projectId: string;
    readonly source?: { readonly agent?: { readonly role: "conversation" | "work" } | undefined };
  },
>(threads: ReadonlyArray<T>, mode: SidebarMode, classifier: SidebarModeThreadClassifier): T[] {
  return threads.filter(
    (thread) =>
      thread.source?.agent?.role !== "work" && sidebarModeForThread(thread, classifier) === mode,
  );
}

// Chats ---------------------------------------------------------------------

export type ChatDateGroup = "today" | "yesterday" | "previous7Days" | "older";

export const CHAT_DATE_GROUP_LABELS: Record<ChatDateGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  previous7Days: "Previous 7 days",
  older: "Older",
};

/** The time a chat row shows and sorts by: the last user message, else the last update. */
export function chatActivityAt(thread: {
  readonly latestUserMessageAt: string | null;
  readonly updatedAt: string;
}): string {
  return thread.latestUserMessageAt ?? thread.updatedAt;
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Buckets by local calendar day, the way a person reads "today" and "yesterday". */
export function chatDateGroup(timestamp: string, now: Date): ChatDateGroup {
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return "older";
  const today = startOfLocalDay(now);
  if (at >= today) return "today";
  const yesterday = startOfLocalDay(new Date(today - 1));
  if (at >= yesterday) return "yesterday";
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);
  if (at >= weekAgo.getTime()) return "previous7Days";
  return "older";
}

/** Newest first, so the date groups read top-down in order. */
export function sortChatsByActivity<
  T extends { readonly latestUserMessageAt: string | null; readonly updatedAt: string },
>(threads: ReadonlyArray<T>): T[] {
  return threads.toSorted((left, right) => {
    const leftAt = Date.parse(chatActivityAt(left));
    const rightAt = Date.parse(chatActivityAt(right));
    return (Number.isNaN(rightAt) ? 0 : rightAt) - (Number.isNaN(leftAt) ? 0 : leftAt);
  });
}

/**
 * Feed rows in render order; returns a group label for the first row of each
 * new date group and null otherwise. Fresh per render.
 */
export function createChatDateGrouper(now: Date) {
  let previous: ChatDateGroup | null = null;
  return (thread: {
    readonly latestUserMessageAt: string | null;
    readonly updatedAt: string;
  }): ChatDateGroup | null => {
    const group = chatDateGroup(chatActivityAt(thread), now);
    if (group === previous) return null;
    previous = group;
    return group;
  };
}

// Tasks ---------------------------------------------------------------------

export interface TaskProjectGroup<T> {
  readonly projectKey: string;
  readonly threads: T[];
}

/**
 * One block per project, the project with the most recent activity first.
 * Rows keep the order they arrive in within their block, and blocks with the
 * same activity keep their first-seen order.
 */
export function groupTasksByProject<
  T extends { readonly latestUserMessageAt: string | null; readonly updatedAt: string },
>(threads: ReadonlyArray<T>, projectKeyOf: (thread: T) => string): TaskProjectGroup<T>[] {
  const groups = new Map<string, { projectKey: string; threads: T[]; latestAt: number }>();
  for (const thread of threads) {
    const projectKey = projectKeyOf(thread);
    const parsed = Date.parse(chatActivityAt(thread));
    const activityAt = Number.isNaN(parsed) ? 0 : parsed;
    const group = groups.get(projectKey);
    if (group) {
      group.threads.push(thread);
      group.latestAt = Math.max(group.latestAt, activityAt);
    } else {
      groups.set(projectKey, { projectKey, threads: [thread], latestAt: activityAt });
    }
  }
  return [...groups.values()]
    .toSorted((left, right) => right.latestAt - left.latestAt)
    .map(({ projectKey, threads: groupThreads }) => ({ projectKey, threads: groupThreads }));
}

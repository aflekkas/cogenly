/**
 * The sidebar lists one of three kinds of work at a time, or the projects
 * that tie them together:
 *
 * - Chats: threads in an environment's scratch ("No project") project.
 * - Work: coding threads in real projects, plus every thread an agent started
 *   to do work, wherever it runs. Shown as "Work"; the id stays `tasks`
 *   because persisted settings and keybindings store it.
 * - Agents: persistent agent conversations.
 * - Projects: the user's project tags. Lists no threads itself; a project
 *   opens a view of its Work, chats and agents.
 *
 * Every visible thread belongs to one mode, so a thread never shows twice and
 * opening one from anywhere (search, a notification, a link) can switch the
 * sidebar to the mode that lists it.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export type SidebarMode = "chats" | "tasks" | "agents" | "projects";

export const SIDEBAR_MODES: ReadonlyArray<SidebarMode> = ["chats", "tasks", "agents", "projects"];

export const SIDEBAR_MODE_LABELS: Record<SidebarMode, string> = {
  chats: "Chats",
  tasks: "Work",
  agents: "Agents",
  projects: "Projects",
};

export const DEFAULT_SIDEBAR_MODE: SidebarMode = "tasks";

export function isSidebarMode(value: unknown): value is SidebarMode {
  return value === "chats" || value === "tasks" || value === "agents" || value === "projects";
}

export function sidebarModeThreadKey(
  environmentId: EnvironmentId | string,
  threadId: ThreadId | string,
) {
  return `${environmentId}:${threadId}`;
}

/**
 * Agent work wins over everything: an agent's coding run is Work, even in a
 * scratch project. Agent conversations win over chats.
 */
export function classifySidebarThreadMode(input: {
  readonly isAgent: boolean;
  readonly isScratch: boolean;
  readonly isAgentWork?: boolean;
}): SidebarThreadMode {
  if (input.isAgentWork) return "tasks";
  if (input.isAgent) return "agents";
  return input.isScratch ? "chats" : "tasks";
}

/** The modes a thread can belong to; Projects lists none itself. */
export type SidebarThreadMode = Exclude<SidebarMode, "projects">;

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
): SidebarThreadMode {
  return classifySidebarThreadMode({
    isAgentWork: thread.source?.agent?.role === "work",
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
  return threads.filter((thread) => sidebarModeForThread(thread, classifier) === mode);
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

/** How many chats the list renders up front, and how many more each scroll to the end reveals. */
export const CHAT_LIST_PAGE_SIZE = 50;

/**
 * The chats the list renders: the newest `visibleCount`, plus the open chat
 * when it sits further down, so its highlight never hides. The open chat is
 * older than every windowed row, so appending it keeps the date groups in
 * order. Search reads the full list, not this window.
 */
export function windowChatList<T>(
  chats: ReadonlyArray<T>,
  visibleCount: number,
  isOpen: (chat: T) => boolean,
): { readonly visible: ReadonlyArray<T>; readonly hiddenCount: number } {
  if (chats.length <= visibleCount) return { visible: chats, hiddenCount: 0 };
  const visible = chats.slice(0, visibleCount);
  const open = chats.slice(visibleCount).find(isOpen);
  if (open !== undefined) visible.push(open);
  return { visible, hiddenCount: chats.length - visible.length };
}

/** What mod+n (`chat.new`) makes: Chats always starts a plain chat, never a repository draft. */
export function newThreadShortcutTarget(input: {
  readonly mode: SidebarMode;
  readonly legacySidebar: boolean;
  readonly repositoryCount: number;
}): "chat" | "repository-picker" | "current-repository" {
  if (input.legacySidebar) return "current-repository";
  if (input.mode === "chats") return "chat";
  return input.repositoryCount > 1 ? "repository-picker" : "current-repository";
}

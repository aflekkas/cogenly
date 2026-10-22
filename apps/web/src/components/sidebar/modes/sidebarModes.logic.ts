/**
 * The sidebar lists one of three kinds of work at a time, or the projects
 * that tie them together:
 *
 * - Chats: threads started from Chats.
 * - Work: threads started from Work, with or without a project, plus every
 *   thread an agent started to do work, wherever it runs. Shown as "Work"; the id stays `tasks`
 *   because persisted settings and keybindings store it.
 * - Agents: persistent agent conversations.
 * - Projects: the user's project tags. Lists no threads itself; a project
 *   opens a view of its Work, chats and agents.
 *
 * Every visible thread belongs to one mode, so a thread never shows twice and
 * opening one from anywhere (search, a notification, a link) can switch the
 * sidebar to the mode that lists it.
 */
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId, ThreadId, ThreadSurface } from "@t3tools/contracts";

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
 * scratch project. Agent conversations win over chats. Past that, the surface
 * the thread was created from decides; only threads that predate the field
 * (no `surface`) fall back to the old guess that a scratch project means chat.
 * Builder threads are listed nowhere, so they classify to no mode.
 */
export function classifySidebarThreadMode(input: {
  readonly isAgent: boolean;
  readonly isScratch: boolean;
  readonly isAgentWork?: boolean;
  readonly surface?: ThreadSurface | undefined;
}): SidebarThreadMode | null {
  if (input.surface === "builder") return null;
  if (input.isAgentWork) return "tasks";
  if (input.isAgent) return "agents";
  if (input.surface !== undefined) return input.surface === "chat" ? "chats" : "tasks";
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
    readonly source?: {
      readonly agent?: { readonly role: "conversation" | "work" } | undefined;
      readonly surface?: ThreadSurface | undefined;
    };
  },
  classifier: SidebarModeThreadClassifier,
): SidebarThreadMode | null {
  return classifySidebarThreadMode({
    isAgentWork: thread.source?.agent?.role === "work",
    isAgent:
      thread.source?.agent !== undefined ||
      classifier.agentThreadKeys.has(sidebarModeThreadKey(thread.environmentId, thread.id)),
    isScratch: classifier.scratchProjectKeys.has(`${thread.environmentId}:${thread.projectId}`),
    surface: thread.source?.surface,
  });
}

export function filterThreadsForSidebarMode<
  T extends {
    readonly environmentId: EnvironmentId | string;
    readonly id: ThreadId | string;
    readonly projectId: string;
    readonly source?: {
      readonly agent?: { readonly role: "conversation" | "work" } | undefined;
      readonly surface?: ThreadSurface | undefined;
    };
  },
>(threads: ReadonlyArray<T>, mode: SidebarMode, classifier: SidebarModeThreadClassifier): T[] {
  return threads.filter((thread) => sidebarModeForThread(thread, classifier) === mode);
}

// Chats ---------------------------------------------------------------------

export type ChatDateGroup = "today" | "yesterday" | "previous7Days" | "older";

/** The headings a Chats list shows: Pinned on top, then the date groups. */
export type ChatListGroup = "pinned" | ChatDateGroup;

export const CHAT_DATE_GROUP_LABELS: Record<ChatListGroup, string> = {
  pinned: "Pinned",
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

/** The heading a chat sits under: Pinned whatever its date, else its date group. */
export function chatListGroupOf(
  thread: {
    readonly latestUserMessageAt: string | null;
    readonly updatedAt: string;
    readonly pinnedAt?: string | null;
  },
  now: Date,
): ChatListGroup {
  return thread.pinnedAt != null ? "pinned" : chatDateGroup(chatActivityAt(thread), now);
}

/**
 * Each heading's chat count, for the counts on the Chats date headings. Reads
 * the whole list, not the rendered page, so a heading counts every chat it holds.
 */
export function countChatListGroups(
  threads: ReadonlyArray<{
    readonly latestUserMessageAt: string | null;
    readonly updatedAt: string;
    readonly pinnedAt?: string | null;
  }>,
  now: Date,
): Map<ChatListGroup, number> {
  const counts = new Map<ChatListGroup, number>();
  for (const thread of threads) {
    const group = chatListGroupOf(thread, now);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return counts;
}

/**
 * The Chats list order: pinned chats first in their arranged order
 * (`pinOrderKey`), then every other chat newest first. A pinned chat is
 * listed only once, under Pinned.
 */
export function orderChatsWithPins<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly latestUserMessageAt: string | null;
    readonly updatedAt: string;
    readonly pinnedAt: string | null;
    readonly pinOrderKey: string | null;
    readonly environmentId?: string | undefined;
  },
>(threads: ReadonlyArray<T>): T[] {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const thread of threads) (thread.pinnedAt != null ? pinned : rest).push(thread);
  return [...sortPinnedThreadsByOrderKey(pinned), ...sortChatsByActivity(rest)];
}

/**
 * The Chats list while a pinned chat is being dragged: pinned chats follow
 * `pinnedOrder` (keys), with any pin the drag didn't know about (pinned
 * from another device mid-drag) after them in their existing order. The
 * unpinned rest is untouched.
 */
export function applyPinnedDragOrder<T extends { readonly pinnedAt: string | null }>(
  chats: ReadonlyArray<T>,
  pinnedOrder: ReadonlyArray<string>,
  keyOf: (chat: T) => string,
): ReadonlyArray<T> {
  const rank = new Map(pinnedOrder.map((key, index) => [key, index]));
  const pinned = chats.filter((chat) => chat.pinnedAt != null);
  const ranked = pinned
    .map((chat, index) => ({ chat, rank: rank.get(keyOf(chat)) ?? pinnedOrder.length + index }))
    .toSorted((left, right) => left.rank - right.rank)
    .map((entry) => entry.chat);
  return [...ranked, ...chats.filter((chat) => chat.pinnedAt == null)];
}

/**
 * Where a dragged pin lands: `order` with `movedKey` moved to the slot the
 * pointer is over. `midpoints` are the layout midpoints of the other pinned
 * rows, top to bottom; the pointer passes a row once it crosses its middle.
 */
export function pinnedDragOrder(
  order: ReadonlyArray<string>,
  movedKey: string,
  midpoints: ReadonlyArray<number>,
  pointerY: number,
): string[] {
  const rest = order.filter((key) => key !== movedKey);
  if (rest.length === order.length) return [...order];
  const index = midpoints.filter((midpoint) => midpoint < pointerY).length;
  return [...rest.slice(0, index), movedKey, ...rest.slice(index)];
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
 * Feed rows in render order (see `orderChatsWithPins`); returns a group label
 * for the first row of each new group and null otherwise. Pinned chats group
 * under Pinned whatever their date. Fresh per render.
 */
export function createChatDateGrouper(now: Date) {
  let previous: ChatListGroup | null = null;
  return (thread: {
    readonly latestUserMessageAt: string | null;
    readonly updatedAt: string;
    readonly pinnedAt?: string | null;
  }): ChatListGroup | null => {
    const group = chatListGroupOf(thread, now);
    if (group === previous) return null;
    previous = group;
    return group;
  };
}

/** How many chats the list renders up front, and how many more each scroll to the end reveals. */
export const CHAT_LIST_PAGE_SIZE = 50;

/**
 * The chats the list renders: the newest `visibleCount`, plus the open chat
 * when it sits further down, so its highlight never hides. Pinned chats
 * lead the list, so they always render. The open chat is older than every
 * windowed row, so appending it keeps the date groups in order. Search reads the full list, not this window.
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

import type { ThreadSurface } from "@t3tools/contracts";

import type { SidebarThreadMode } from "./components/sidebar/modes/sidebarModes.logic";

/**
 * The three kinds of thread a user works with:
 *
 * - `chat`: a conversation started from Chats, usually in an environment's scratch folder.
 * - `work`: a session started from Work, with or without a repository, including Work an agent started.
 * - `agentConversation`: an agent's own conversation. The agent owns its name and lifetime.
 */
export type ThreadKind = "chat" | "work" | "agentConversation";

/**
 * What a user can do with a thread of one kind. Every surface that offers a
 * thread action (title menu, sidebar row menu, command palette, shortcuts,
 * header, right panel and composer controls) asks here, so a chat never grows
 * a Work control by accident. Unsupported actions are hidden, not disabled.
 */
export interface ThreadCapabilities {
  /** Hand the conversation off to a new Work session. */
  readonly startWork: boolean;
  readonly rename: boolean;
  readonly regenerateTitle: boolean;
  /** Mark unread, and its reverse, mark read. */
  readonly markUnread: boolean;
  /** Move to a project folder, and remove from it. */
  readonly projectFolder: boolean;
  /** Settle, and un-settle. */
  readonly settle: boolean;
  /** Snooze, and wake. */
  readonly snooze: boolean;
  readonly autoSettle: boolean;
  /** Archive, and unarchive from Settings → Archived threads. */
  readonly archive: boolean;
  /**
   * `"always-confirm"` asks first whatever the confirm-delete setting says,
   * `"setting"` follows that setting, and `false` offers no delete.
   */
  readonly delete: false | "setting" | "always-confirm";
  /** Copy the thread link (Markdown) and thread id. */
  readonly copyLink: boolean;
  /** Copy the workspace path and branch. */
  readonly copyWorkspace: boolean;
  readonly repositorySettings: boolean;
  /** Branch, worktree and git actions, the composer's workspace and branch pickers, and new thread on branch. */
  readonly git: boolean;
  readonly terminal: boolean;
  /** Files panel, go to file and repository search. */
  readonly files: boolean;
  readonly agentSettings: boolean;
}

const CAPABILITIES: Record<ThreadKind, ThreadCapabilities> = {
  // A chat is a conversation, not a session: it has no repository to act on
  // and no Settled or Snoozed shelf to land in. Without archive, delete is its
  // only way out and clears the history for good, so it always asks first.
  chat: {
    startWork: true,
    rename: true,
    regenerateTitle: true,
    markUnread: true,
    projectFolder: true,
    settle: false,
    snooze: false,
    autoSettle: false,
    archive: false,
    delete: "always-confirm",
    copyLink: true,
    copyWorkspace: false,
    repositorySettings: false,
    git: false,
    terminal: false,
    files: false,
    agentSettings: false,
  },
  work: {
    startWork: false,
    rename: true,
    regenerateTitle: true,
    markUnread: true,
    projectFolder: true,
    settle: true,
    snooze: true,
    autoSettle: true,
    archive: true,
    delete: "setting",
    copyLink: true,
    copyWorkspace: true,
    repositorySettings: true,
    git: true,
    terminal: true,
    files: true,
    agentSettings: false,
  },
  // The agent owns this thread: its name is the title, and deleting the agent
  // removes the conversation. Agents reach every project, so the conversation
  // is filed in no project folder of its own.
  agentConversation: {
    startWork: false,
    rename: false,
    regenerateTitle: false,
    markUnread: true,
    projectFolder: false,
    settle: false,
    snooze: false,
    autoSettle: false,
    archive: false,
    delete: false,
    copyLink: true,
    copyWorkspace: false,
    repositorySettings: false,
    git: false,
    terminal: false,
    files: false,
    agentSettings: true,
  },
};

export function threadCapabilities(kind: ThreadKind): ThreadCapabilities {
  return CAPABILITIES[kind];
}

/** The sidebar mode that lists a thread names its kind. */
export function threadKindForSidebarMode(mode: SidebarThreadMode): ThreadKind {
  return mode === "chats" ? "chat" : mode === "agents" ? "agentConversation" : "work";
}

/**
 * The kind of a thread from what the client knows about it. Agent-started
 * Work is Work wherever it runs; an agent's conversation wins over a scratch
 * folder.
 */
export function classifyThreadKind(input: {
  readonly agentRole: "conversation" | "work" | null;
  /** Listed as some agent's conversation, for agents whose thread carries no source. */
  readonly isAgentConversation?: boolean;
  /** The surface the thread was created from; absent on threads from before it was recorded. */
  readonly surface?: ThreadSurface | undefined;
  readonly isScratch: boolean;
}): ThreadKind {
  if (input.agentRole === "work") return "work";
  if (input.agentRole === "conversation" || input.isAgentConversation) return "agentConversation";
  if (input.surface !== undefined) return input.surface;
  return input.isScratch ? "chat" : "work";
}

/** The sidebar mode that lists threads of a kind. */
export function sidebarModeForThreadKind(kind: ThreadKind): SidebarThreadMode {
  return kind === "chat" ? "chats" : kind === "agentConversation" ? "agents" : "tasks";
}

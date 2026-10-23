import type { EnvironmentId, ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";

import type { SidebarMode, SidebarThreadMode } from "./sidebarModes.logic";

/**
 * What the main panel shows when nothing is selected in a mode: the index
 * route, and every hand-picked mode switch that would otherwise leave a thread
 * of another kind beside the list.
 *
 * - Chats opens the most recent chat, else a new plain chat. Never a
 *   repository draft.
 * - Work opens a new draft in the most recently active repository.
 * - Agents opens the most recent agent's conversation, else its empty state.
 */
export type ModeLanding =
  | { readonly kind: "wait" }
  | { readonly kind: "open-thread"; readonly threadRef: ScopedThreadRef }
  | { readonly kind: "new-chat"; readonly environmentId: EnvironmentId }
  | { readonly kind: "chats-unavailable" }
  | { readonly kind: "repository-draft"; readonly projectRef: ScopedProjectRef }
  | { readonly kind: "no-repositories" }
  | { readonly kind: "agents-empty" };

export function resolveModeLanding(input: {
  readonly mode: SidebarMode;
  /** Every environment's threads and projects have reached this client. */
  readonly bootstrapped: boolean;
  /** The newest unarchived chat. */
  readonly recentChat: ScopedThreadRef | null;
  /** Where a new chat would start, or null when no machine offers one. */
  readonly chatEnvironmentId: EnvironmentId | null;
  /** The most recently active repository, never a scratch folder. */
  readonly recentRepository: ScopedProjectRef | null;
  /** The most recently active agent's conversation. */
  readonly recentAgentConversation: ScopedThreadRef | null;
  /** The agents list has loaded, so an empty one means there are none. */
  readonly agentsLoaded: boolean;
}): ModeLanding {
  switch (input.mode) {
    case "agents":
      if (input.recentAgentConversation !== null)
        return { kind: "open-thread", threadRef: input.recentAgentConversation };
      return input.agentsLoaded ? { kind: "agents-empty" } : { kind: "wait" };
    case "chats":
      if (!input.bootstrapped) return { kind: "wait" };
      if (input.recentChat !== null) return { kind: "open-thread", threadRef: input.recentChat };
      return input.chatEnvironmentId !== null
        ? { kind: "new-chat", environmentId: input.chatEnvironmentId }
        : { kind: "chats-unavailable" };
    case "tasks":
      if (!input.bootstrapped) return { kind: "wait" };
      return input.recentRepository !== null
        ? { kind: "repository-draft", projectRef: input.recentRepository }
        : { kind: "no-repositories" };
  }
}

/** What the main panel shows right now, as far as mode switching cares. */
export type MainPanelContent =
  | { readonly kind: "thread"; readonly mode: SidebarThreadMode }
  | { readonly kind: "index" }
  | { readonly kind: "other" };

/**
 * Whether picking `mode` by hand must replace the main panel: it shows a
 * thread (or draft) another mode lists. The index lands again on its own, and
 * pages outside the thread routes keep their own back navigation.
 */
export function modeSwitchReplacesMainPanel(mode: SidebarMode, content: MainPanelContent): boolean {
  switch (content.kind) {
    case "thread":
      return content.mode !== mode;
    case "index":
    case "other":
      return false;
  }
}

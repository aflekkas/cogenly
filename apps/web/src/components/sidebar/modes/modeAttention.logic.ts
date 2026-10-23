import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

import { agentAttentionCount } from "../../../agents/agentWorkspace.logic";
import {
  filterSidebarV2VisibleThreads,
  isSidebarThreadAwaitingUser,
  resolveThreadListSection,
} from "../../Sidebar.logic";
import {
  sidebarModeForThread,
  type SidebarMode,
  type SidebarModeThreadClassifier,
} from "./sidebarModes.logic";

/** A mode's accessible name while its dot is lit: "Chats — needs you". */
export const modeNeedsYouLabel = (modeLabel: string) => `${modeLabel} — needs you`;

/**
 * The modes holding something that waits on you, for the navigation rail's dots.
 * It asks the sidebar's own questions, so a dot is lit exactly when its mode's
 * list shows a "needs you" row:
 *
 * - Chats and Work: an active thread that `isSidebarThreadAwaitingUser` (Work's
 *   Needs attention filter): a provider approval or owner approval, a question
 *   (its own or a subagent's), or a plan awaiting approval once its turn ended.
 *   Archived, subagent, snoozed and settled threads do not count; a snoozed
 *   thread that asks for something is active again (`effectiveSnoozed`).
 * - Agents: an agent with `agentAttentionCount` above zero (its Needs attention
 *   filter), which covers its open approvals, run questions and Work it started.
 *
 * Unread completions ("Done") and woke markers are news, not requests, and
 * never count, as in the Needs attention filters.
 */
export function modesNeedingAttention(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly classifier: SidebarModeThreadClassifier;
  readonly agents: ReadonlyArray<Parameters<typeof agentAttentionCount>[0]>;
  /** Per environment, what its server can park (snooze, settle). */
  readonly capabilities: (
    environmentId: EnvironmentId,
  ) => { readonly threadSettlement?: boolean; readonly threadSnooze?: boolean } | undefined;
  /** ISO time that snoozes are judged against. */
  readonly now: string;
}): Set<SidebarMode> {
  const modes = new Set<SidebarMode>();
  if (input.agents.some((agent) => agentAttentionCount(agent) > 0)) modes.add("agents");
  for (const thread of filterSidebarV2VisibleThreads(input.threads, null)) {
    const mode = sidebarModeForThread(thread, input.classifier);
    // Agent conversations are the Agents list's own rows, judged above.
    if (mode === null || mode === "agents" || modes.has(mode)) continue;
    const section = resolveThreadListSection(thread, {
      chatsMode: mode === "chats",
      capabilities: input.capabilities(thread.environmentId),
      now: input.now,
    });
    if (section === "active" && isSidebarThreadAwaitingUser(thread)) modes.add(mode);
  }
  return modes;
}

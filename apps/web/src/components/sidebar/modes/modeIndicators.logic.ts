import type { EnvironmentThreadShell } from "@cogenly/client-runtime/state/shell";
import type { EnvironmentId } from "@cogenly/contracts";

import { agentAttentionCount } from "../../../agents/agentWorkspace.logic";
import {
  filterSidebarV2VisibleThreads,
  hasUnseenCompletion,
  isSidebarThreadAwaitingUser,
  resolveThreadListSection,
} from "../../Sidebar.logic";
import {
  sidebarModeForThread,
  type SidebarMode,
  type SidebarModeThreadClassifier,
} from "./sidebarModes.logic";

/** A mode's dot: amber when something waits on you, blue when there is unread news. */
export type ModeIndicatorTone = "warning" | "info";

/** A mode's accessible name while its dot is lit: "Chats — needs you", "Chats — unread". */
export const modeIndicatorLabel = (modeLabel: string, tone: ModeIndicatorTone) =>
  `${modeLabel} — ${tone === "warning" ? "needs you" : "unread"}`;

/**
 * Each mode's dot on the navigation rail. It asks the sidebar's own questions,
 * so a dot is lit exactly when its mode's list shows a lit row. Amber wins over
 * blue: a mode with both shows amber.
 *
 * - Chats and Work: an active thread (archived, subagent, snoozed and settled
 *   threads do not count; a snoozed thread that asks for something is active
 *   again, `effectiveSnoozed`). Amber when it `isSidebarThreadAwaitingUser`
 *   (an approval, a question, or a plan awaiting approval once its turn
 *   ended); blue when it has a finished turn you have not seen
 *   (`hasUnseenCompletion`, the row's own unread dot).
 * - Agents: amber for an agent with `agentAttentionCount` above zero (its
 *   open approvals, run questions and Work it started); blue for an agent
 *   with unread messages.
 */
export function modeIndicators(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly classifier: SidebarModeThreadClassifier;
  readonly agents: ReadonlyArray<
    Parameters<typeof agentAttentionCount>[0] & { readonly unreadCount?: number }
  >;
  /** Per environment, what its server can park (snooze, settle). */
  readonly capabilities: (
    environmentId: EnvironmentId,
  ) => { readonly threadSettlement?: boolean; readonly threadSnooze?: boolean } | undefined;
  /** The thread's effective read watermark (`resolveThreadLastVisitedAt`). */
  readonly lastVisitedAt: (thread: EnvironmentThreadShell) => string | undefined;
  /** ISO time that snoozes are judged against. */
  readonly now: string;
}): Map<SidebarMode, ModeIndicatorTone> {
  const modes = new Map<SidebarMode, ModeIndicatorTone>();
  if (input.agents.some((agent) => agentAttentionCount(agent) > 0)) modes.set("agents", "warning");
  else if (input.agents.some((agent) => (agent.unreadCount ?? 0) > 0)) modes.set("agents", "info");
  for (const thread of filterSidebarV2VisibleThreads(input.threads, null)) {
    const mode = sidebarModeForThread(thread, input.classifier);
    // Agent conversations are the Agents list's own rows, judged above.
    if (mode === null || mode === "agents" || modes.get(mode) === "warning") continue;
    const section = resolveThreadListSection(thread, {
      chatsMode: mode === "chats",
      capabilities: input.capabilities(thread.environmentId),
      now: input.now,
    });
    if (section !== "active") continue;
    if (isSidebarThreadAwaitingUser(thread)) modes.set(mode, "warning");
    else if (hasUnseenCompletion({ ...thread, lastVisitedAt: input.lastVisitedAt(thread) })) {
      modes.set(mode, "info");
    }
  }
  return modes;
}

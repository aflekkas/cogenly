import { requestAgentCreation } from "../../../agents/AgentsCreateHost";
import type { EnvironmentId, ScheduledTaskId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { useScratchProject } from "../../../hooks/useScratchProject";
import { useSidebar } from "../../ui/sidebar";
import type { SidebarMode } from "./sidebarModes.logic";

const NEW_ITEM_LABELS: Record<SidebarMode, string> = {
  chats: "New chat",
  tasks: "New work",
  agents: "New agent",
};

/**
 * Creation and navigation that differ by mode: the header's new button makes a
 * scratch chat in Chats and an agent in Agents (Work keeps the
 * sidebar's own new-thread flow).
 */
export function useSidebarModeActions(input: {
  readonly mode: SidebarMode;
  /** The machine the user is working on: the open thread's, else the primary one. */
  readonly currentEnvironmentId: EnvironmentId | null;
}) {
  const { mode, currentEnvironmentId } = input;
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const { startNewChat } = useScratchProject();

  const startChat = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    startNewChat(currentEnvironmentId);
  }, [currentEnvironmentId, isMobile, setOpenMobile, startNewChat]);

  const createAgent = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    requestAgentCreation(currentEnvironmentId);
  }, [currentEnvironmentId, isMobile, setOpenMobile]);

  const openAgentTask = useCallback(
    (environmentId: EnvironmentId, taskId: ScheduledTaskId) => {
      if (isMobile) setOpenMobile(false);
      void router.navigate({ to: "/settings/scheduled-tasks", search: { environmentId, taskId } });
    },
    [isMobile, router, setOpenMobile],
  );

  return {
    newItemLabel: NEW_ITEM_LABELS[mode],
    /** Null in Work, where the sidebar's existing new-thread handler applies. */
    createInMode: mode === "chats" ? startChat : mode === "agents" ? createAgent : null,
    startChat,
    createAgent,
    openAgentTask,
  };
}

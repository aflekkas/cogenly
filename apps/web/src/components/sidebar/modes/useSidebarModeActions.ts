import { requestAgentCreation } from "../../../agents/AgentsCreateHost";
import type { EnvironmentId, ScheduledTaskId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { useScratchProject } from "../../../hooks/useScratchProject";
import { openCreateProjectDialog } from "../../../projectLabels/CreateProjectDialogHost";
import { useSidebar } from "../../ui/sidebar";
import type { SidebarMode } from "./sidebarModes.logic";

const NEW_ITEM_LABELS: Record<SidebarMode, string> = {
  chats: "New chat",
  tasks: "New task",
  agents: "New agent",
};

/**
 * Creation and navigation that differ by mode: the search dock's new button
 * makes a scratch chat in Chats and an agent in Agents (Work keeps the
 * sidebar's own new-thread flow). `createProject` serves the dock's
 * new-project button in every mode.
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

  const createProject = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    if (currentEnvironmentId !== null) {
      openCreateProjectDialog({ environmentId: currentEnvironmentId });
      return;
    }
    // No machine to create on yet: the projects page offers the dialog once one connects.
    void router.navigate({ to: "/project", search: { create: true } });
  }, [currentEnvironmentId, isMobile, router, setOpenMobile]);

  const openAgentTask = useCallback(
    (environmentId: EnvironmentId, taskId: ScheduledTaskId) => {
      if (isMobile) setOpenMobile(false);
      void router.navigate({ to: "/settings/scheduled-tasks", search: { environmentId, taskId } });
    },
    [isMobile, router, setOpenMobile],
  );

  return {
    newItemLabel: NEW_ITEM_LABELS[mode],
    startChat,
    createAgent,
    createProject,
    openAgentTask,
  };
}

import { agentThreadRole } from "../../../agents/agents.logic";
import { useAgents } from "../../../agents/agentsClient";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId, ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { resolveShortcutCommand } from "../../../keybindings";
import { useConnectedEnvironmentIds } from "../../../state/environments";
import { useUiStateStore } from "../../../uiStateStore";
import {
  filterThreadsForSidebarMode,
  sidebarModeForThread,
  sidebarModeThreadKey,
  type SidebarMode,
  type SidebarModeThreadClassifier,
} from "./sidebarModes.logic";
import { useAgentScheduledTasks } from "./useAgentScheduledTasks";

const MODE_BY_COMMAND: Record<string, SidebarMode> = {
  "sidebar.mode.chats": "chats",
  "sidebar.mode.tasks": "tasks",
  "sidebar.mode.agents": "agents",
};

export interface SidebarModeState {
  readonly mode: SidebarMode;
  readonly setMode: (mode: SidebarMode) => void;
  /** The threads the current mode lists; feed these to the sidebar's partition. */
  readonly modeThreads: ReadonlyArray<EnvironmentThreadShell>;
  /** Project keys whose new-thread drafts belong in the current mode; null for all. */
  readonly draftProjectKeys: ReadonlySet<string> | null;
  readonly agentsNeedingYou: number;
}

/**
 * Everything the sidebar needs to list one mode at a time. Owns the persisted
 * mode, the mode shortcuts, and following the open thread into its mode.
 */
export function useSidebarModeState(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, { readonly scratchWorkspaceRoot?: string }>;
  /** The sidebar's project scope, or null for all projects. */
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly routeThreadRef: ScopedThreadRef | null;
  readonly keybindings: ResolvedKeybindingsConfig;
  /** Group label per `environmentId:projectId`. */
  readonly projectDisplayNameByKey: ReadonlyMap<string, string>;
}): SidebarModeState {
  const { threads, projects, serverConfigs, scopedProjectKeys, routeThreadRef, keybindings } =
    input;
  const mode = useUiStateStore((store) => store.sidebarMode);
  const setMode = useUiStateStore((store) => store.setSidebarMode);

  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  // A connected environment's config arrives a beat later; until then its
  // task subscription has nothing to say.
  const taskEnvironmentIds = useMemo(
    () => connectedEnvironmentIds.filter((environmentId) => serverConfigs.has(environmentId)),
    [connectedEnvironmentIds, serverConfigs],
  );
  const scheduledTasks = useAgentScheduledTasks(taskEnvironmentIds);
  const { agents } = useAgents();

  const scratchProjectKeys = useMemo(
    () =>
      new Set(
        projects
          .filter(
            (project) =>
              project.isScratch === true ||
              isScratchProject(
                project,
                serverConfigs.get(project.environmentId)?.scratchWorkspaceRoot,
              ),
          )
          .map((project) => `${project.environmentId}:${project.id}`),
      ),
    [projects, serverConfigs],
  );
  const classifier = useMemo((): SidebarModeThreadClassifier => {
    const agentThreadKeys = new Set(
      agents.map((agent) => sidebarModeThreadKey(agent.environmentId, agent.conversationThreadId)),
    );
    for (const thread of threads) {
      if (agentThreadRole(thread.source) === "conversation")
        agentThreadKeys.add(sidebarModeThreadKey(thread.environmentId, thread.id));
    }
    for (const { environmentId, task } of scheduledTasks) {
      if (task.threadId !== null)
        agentThreadKeys.add(sidebarModeThreadKey(environmentId, task.threadId));
    }
    return { agentThreadKeys, scratchProjectKeys };
  }, [agents, scheduledTasks, scratchProjectKeys, threads]);

  const modeThreads = useMemo(
    () =>
      filterThreadsForSidebarMode(
        threads.filter((thread) => agentThreadRole(thread.source) !== "work"),
        mode,
        classifier,
      ),
    [classifier, mode, threads],
  );

  const draftProjectKeys = useMemo((): ReadonlySet<string> | null => {
    if (mode === "agents") return new Set();
    const keys = projects
      .map((project) => `${project.environmentId}:${project.id}`)
      .filter((key) => (mode === "chats") === scratchProjectKeys.has(key))
      .filter(
        (key) => mode === "chats" || scopedProjectKeys === null || scopedProjectKeys.has(key),
      );
    return new Set(keys);
  }, [mode, projects, scopedProjectKeys, scratchProjectKeys]);

  const agentsNeedingYou = useMemo(
    () => agents.filter((agent) => agent.state === "blocked" || agent.state === "needsYou").length,
    [agents],
  );

  // Opening a thread that another mode lists (search, notification, link)
  // switches to that mode. Keyed on the thread's own mode, so picking a
  // segment by hand while a thread stays open never bounces back.
  const routeThread = useMemo(() => {
    if (routeThreadRef === null) return null;
    return (
      threads.find(
        (thread) =>
          thread.environmentId === routeThreadRef.environmentId &&
          thread.id === routeThreadRef.threadId,
      ) ?? null
    );
  }, [routeThreadRef, threads]);
  const routeThreadMode = routeThread ? sidebarModeForThread(routeThread, classifier) : null;
  const routeThreadKey = routeThread
    ? sidebarModeThreadKey(routeThread.environmentId, routeThread.id)
    : null;
  useEffect(() => {
    if (routeThreadKey !== null && routeThreadMode !== null) setMode(routeThreadMode);
  }, [routeThreadKey, routeThreadMode, setMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const command = resolveShortcutCommand(event, keybindings);
      const next = command ? MODE_BY_COMMAND[command] : undefined;
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      setMode(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, setMode]);

  return { mode, setMode, modeThreads, draftProjectKeys, agentsNeedingYou };
}

import { useAgents } from "../../../agents/agentsClient";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId, ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { resolveShortcutCommand } from "../../../keybindings";
import { useUiStateStore } from "../../../uiStateStore";
import {
  filterThreadsForSidebarMode,
  sidebarModeForThread,
  sidebarModeThreadKey,
  type SidebarMode,
  type SidebarModeThreadClassifier,
} from "./sidebarModes.logic";

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
  /** Agent names by `environmentId:agentId`, for marking the Work an agent started. */
  readonly agentNameByKey: ReadonlyMap<string, string>;
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
      if (thread.source.agent?.role === "conversation")
        agentThreadKeys.add(sidebarModeThreadKey(thread.environmentId, thread.id));
    }
    return { agentThreadKeys, scratchProjectKeys };
  }, [agents, scratchProjectKeys, threads]);

  const modeThreads = useMemo(
    () => filterThreadsForSidebarMode(threads, mode, classifier),
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

  const agentNameByKey = useMemo(
    () => new Map(agents.map((agent) => [`${agent.environmentId}:${agent.id}`, agent.name])),
    [agents],
  );

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

  return { mode, setMode, modeThreads, draftProjectKeys, agentsNeedingYou, agentNameByKey };
}

import { useAgents } from "../../../agents/agentsClient";
import { decisionsWaitingCount } from "../../../agents/agentWorkspace.logic";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type {
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
  ThreadSurface,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo } from "react";

import { resolveShortcutCommand } from "../../../keybindings";
import { useSelectSidebarMode } from "./useSelectSidebarMode";
import { useUiStateStore } from "../../../uiStateStore";
import {
  classifySidebarThreadMode,
  filterThreadsForSidebarMode,
  sidebarModeForThread,
  sidebarModeThreadKey,
  type SidebarMode,
  type SidebarModeThreadClassifier,
} from "./sidebarModes.logic";

interface DraftModeShape {
  readonly environmentId: string;
  readonly projectId: string;
  readonly surface?: ThreadSurface | undefined;
}

const MODE_BY_COMMAND: Record<string, SidebarMode> = {
  "sidebar.mode.chats": "chats",
  "sidebar.mode.tasks": "tasks",
  "sidebar.mode.agents": "agents",
  "sidebar.mode.projects": "projects",
};

/**
 * Which mode lists each thread: agent conversations, scratch chats, or Work.
 * Shared by the sidebar and the project view so both sort threads alike.
 */
export function useSidebarModeClassifier(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, { readonly scratchWorkspaceRoot?: string }>;
}) {
  const { threads, projects, serverConfigs } = input;
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
  return { classifier, scratchProjectKeys };
}

export interface SidebarModeState {
  readonly mode: SidebarMode;
  /** Sets the mode and keeps the main panel, for following a thread into its mode. */
  readonly setMode: (mode: SidebarMode) => void;
  /** Picks a mode by hand, replacing a main panel of another kind. */
  readonly selectMode: (mode: SidebarMode) => void;
  /** The threads the current mode lists; feed these to the sidebar's partition. */
  readonly modeThreads: ReadonlyArray<EnvironmentThreadShell>;
  /** Whether a new-thread draft belongs in the current mode, by the surface it was started from. */
  readonly draftInMode: (draft: DraftModeShape) => boolean;
  /** Approvals and run questions waiting on you across agents; never unread messages. */
  readonly decisionsWaiting: number;
  /** Agent names by `environmentId:agentId`, for marking the Work an agent started. */
  readonly agentNameByKey: ReadonlyMap<string, string>;
  /** Which mode lists each thread, and so its kind. */
  readonly classifier: SidebarModeThreadClassifier;
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
  const selectMode = useSelectSidebarMode();

  const { agents } = useAgents();
  const { classifier, scratchProjectKeys } = useSidebarModeClassifier({
    threads,
    projects,
    serverConfigs,
  });

  const modeThreads = useMemo(
    () => filterThreadsForSidebarMode(threads, mode, classifier),
    [classifier, mode, threads],
  );

  const draftInMode = useCallback(
    (draft: DraftModeShape): boolean => {
      if (mode === "agents" || mode === "projects") return false;
      const projectKey = `${draft.environmentId}:${draft.projectId}`;
      const draftMode = classifySidebarThreadMode({
        isAgent: false,
        isScratch: scratchProjectKeys.has(projectKey),
        surface: draft.surface,
      });
      if (draftMode !== mode) return false;
      return mode === "chats" || scopedProjectKeys === null || scopedProjectKeys.has(projectKey);
    },
    [mode, scopedProjectKeys, scratchProjectKeys],
  );

  const agentNameByKey = useMemo(
    () => new Map(agents.map((agent) => [`${agent.environmentId}:${agent.id}`, agent.name])),
    [agents],
  );

  const decisionsWaiting = useMemo(() => decisionsWaitingCount(agents), [agents]);

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
      selectMode(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, selectMode]);

  return {
    mode,
    setMode,
    selectMode,
    modeThreads,
    draftInMode,
    decisionsWaiting,
    agentNameByKey,
    classifier,
  };
}

import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useContext } from "react";

import { sortAgentContacts } from "../../../agents/agents.logic";
import type { AgentContact } from "../../../agents/agents.types";
import { AgentsClientContext } from "../../../agents/agentsContext";
import { useNewThreadHandler } from "../../../hooks/useHandleNewThread";
import { useScratchProject } from "../../../hooks/useScratchProject";
import { appAtomRegistry } from "../../../rpc/atomRegistry";
import { readProject, readProjects, readThreadShells } from "../../../state/entities";
import { usePrimaryEnvironmentId } from "../../../state/environments";
import { environmentServerConfigsAtom } from "../../../state/server";
import { allEnvironmentShellsBootstrappedAtom } from "../../../state/shell";
import { buildThreadRouteParams } from "../../../threadRoutes";
import { sortScopedProjectsForSidebar } from "../../Sidebar.logic";
import { resolveModeLanding, type ModeLanding } from "./modeLanding.logic";
import {
  sidebarModeForThread,
  sidebarModeThreadKey,
  sortChatsByActivity,
  type SidebarMode,
  type SidebarModeThreadClassifier,
} from "./sidebarModes.logic";

type ScratchServerConfigs = ReadonlyMap<EnvironmentId, { readonly scratchWorkspaceRoot?: string }>;

/** `environmentId:projectId` of every scratch folder, which no mode lists as a repository. */
export function buildScratchProjectKeys(
  projects: ReadonlyArray<EnvironmentProject>,
  serverConfigs: ScratchServerConfigs,
): ReadonlySet<string> {
  return new Set(
    projects
      .filter(
        (project) =>
          project.isScratch === true ||
          isScratchProject(project, serverConfigs.get(project.environmentId)?.scratchWorkspaceRoot),
      )
      .map((project) => `${project.environmentId}:${project.id}`),
  );
}

export function buildSidebarModeClassifier(
  agents: ReadonlyArray<Pick<AgentContact, "environmentId" | "conversationThreadId">>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  scratchProjectKeys: ReadonlySet<string>,
): SidebarModeThreadClassifier {
  const agentThreadKeys = new Set(
    agents.map((agent) => sidebarModeThreadKey(agent.environmentId, agent.conversationThreadId)),
  );
  for (const thread of threads) {
    if (thread.source.agent?.role === "conversation")
      agentThreadKeys.add(sidebarModeThreadKey(thread.environmentId, thread.id));
  }
  return { agentThreadKeys, scratchProjectKeys };
}

/** What landing on `mode` opens, from the stores as they read now. */
export function computeModeLanding(input: {
  readonly mode: SidebarMode;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  /** Sorted, most recently active first (sortAgentContacts). */
  readonly agents: ReadonlyArray<AgentContact>;
  readonly agentsLoading: boolean;
  readonly bootstrapped: boolean;
  readonly classifier: SidebarModeThreadClassifier;
  readonly chatEnvironmentId: EnvironmentId | null;
}): ModeLanding {
  const { classifier, threads, projects } = input;
  const recentChat =
    sortChatsByActivity(
      threads.filter(
        (thread) =>
          thread.archivedAt === null && sidebarModeForThread(thread, classifier) === "chats",
      ),
    )[0] ?? null;
  const recentRepository =
    sortScopedProjectsForSidebar(
      projects.filter(
        (project) => !classifier.scratchProjectKeys.has(`${project.environmentId}:${project.id}`),
      ),
      threads,
      "updated_at",
    )[0] ?? null;
  const recentAgent = input.agents[0] ?? null;
  return resolveModeLanding({
    mode: input.mode,
    bootstrapped: input.bootstrapped,
    recentChat: recentChat ? scopeThreadRef(recentChat.environmentId, recentChat.id) : null,
    chatEnvironmentId: input.chatEnvironmentId,
    recentRepository: recentRepository
      ? scopeProjectRef(recentRepository.environmentId, recentRepository.id)
      : null,
    recentAgentConversation: recentAgent
      ? scopeThreadRef(recentAgent.environmentId, recentAgent.conversationThreadId)
      : null,
    agentsLoaded: !input.agentsLoading,
  });
}

/**
 * Opens what a hand-picked mode lands on straight away, without passing
 * through the index route first (one navigation and one router render, not
 * two). Reads the stores when called. Returns false when the landing is not a
 * place to go (still loading, or an empty state the index route shows); the
 * caller then navigates to the index, which lands on its own.
 */
export function useLandOnMode(): (mode: SidebarMode) => boolean {
  const router = useRouter();
  const agentsClient = useContext(AgentsClientContext);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const handleNewThread = useNewThreadHandler();

  return useCallback(
    (mode: SidebarMode) => {
      const threads = readThreadShells();
      const projects = readProjects();
      const agentsSnapshot = agentsClient?.getSnapshot() ?? null;
      const agents = agentsSnapshot ? sortAgentContacts(agentsSnapshot.agents) : [];
      const landing = computeModeLanding({
        mode,
        threads,
        projects,
        agents,
        agentsLoading: agentsSnapshot?.loading ?? false,
        bootstrapped: appAtomRegistry.get(allEnvironmentShellsBootstrappedAtom),
        classifier: buildSidebarModeClassifier(
          agents,
          threads,
          buildScratchProjectKeys(projects, appAtomRegistry.get(environmentServerConfigsAtom)),
        ),
        chatEnvironmentId: scratchEnvironmentId(primaryEnvironmentId),
      });
      const landOnIndex = () => void router.navigate({ to: "/" });
      switch (landing.kind) {
        case "open-thread":
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(landing.threadRef),
          });
          return true;
        case "new-chat":
          void startScratchThread(landing.environmentId, { surface: "chat" });
          return true;
        case "repository-draft":
          if (readProject(landing.projectRef) === null) return false;
          // A repository removed meanwhile, or a failed start: the index
          // lands again and shows the error with its retry.
          void handleNewThread(landing.projectRef).then((opened) => {
            if (opened === null) landOnIndex();
          }, landOnIndex);
          return true;
        default:
          return false;
      }
    },
    [
      agentsClient,
      handleNewThread,
      primaryEnvironmentId,
      router,
      scratchEnvironmentId,
      startScratchThread,
    ],
  );
}

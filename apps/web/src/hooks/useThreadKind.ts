import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { useAgents } from "../agents/agentsClient";
import { useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { classifyThreadKind, type ThreadKind } from "../threadCapabilities";

interface ThreadKindInput {
  readonly environmentId: EnvironmentId;
  /** Absent for a draft, which no agent owns yet. */
  readonly id?: string;
  readonly projectId: string;
  readonly source?: { readonly agent?: { readonly role: "conversation" | "work" } | undefined };
}

/**
 * Resolves a thread's (or draft's) kind from the client's projects, scratch
 * roots and agents, for surfaces that act on threads they read at event time.
 */
export function useThreadKindResolver(): (thread: ThreadKindInput) => ThreadKind {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const { agents } = useAgents();
  return useCallback(
    (thread) => {
      const project = projects.find(
        (candidate) =>
          candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
      );
      const scratchRoot = environments.find(
        (environment) => environment.environmentId === thread.environmentId,
      )?.serverConfig?.scratchWorkspaceRoot;
      return classifyThreadKind({
        agentRole: thread.source?.agent?.role ?? null,
        isAgentConversation:
          thread.id !== undefined &&
          agents.some(
            (agent) =>
              agent.environmentId === thread.environmentId &&
              agent.conversationThreadId === thread.id,
          ),
        isScratch:
          project !== undefined &&
          (project.isScratch === true || isScratchProject(project, scratchRoot ?? null)),
      });
    },
    [agents, environments, projects],
  );
}

/** The kind of one thread or draft, or null while it is unknown. */
export function useThreadKind(thread: ThreadKindInput | null): ThreadKind | null {
  const resolve = useThreadKindResolver();
  return thread === null ? null : resolve(thread);
}

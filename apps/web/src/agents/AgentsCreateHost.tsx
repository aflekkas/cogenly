import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ProjectLabelId } from "@cogenly/contracts";

interface AgentCreationRequest {
  readonly environmentId: EnvironmentId | null;
  readonly projectFolderId?: ProjectLabelId | undefined;
}

/**
 * Every "new agent" entry point (sidebar, palette, the empty state) asks here. Creating
 * an agent is a conversation on its own screen, so the request becomes a navigation.
 * Asked from a project (an Agents list project header), the builder starts filed there.
 */
export function requestAgentCreation(
  environmentId: EnvironmentId | null,
  options?: { readonly projectFolderId?: ProjectLabelId },
) {
  const detail: AgentCreationRequest = { environmentId, projectFolderId: options?.projectFolderId };
  window.dispatchEvent(new CustomEvent("cogenly:create-agent", { detail }));
}
export function AgentsCreateHost() {
  const navigate = useNavigate();
  useEffect(() => {
    const handler = (event: Event) => {
      const { environmentId, projectFolderId } = (event as CustomEvent<AgentCreationRequest>)
        .detail;
      void navigate({
        to: "/agents/new",
        search: {
          ...(environmentId ? { environmentId } : {}),
          ...(environmentId && projectFolderId ? { projectFolderId } : {}),
        },
      });
    };
    window.addEventListener("cogenly:create-agent", handler);
    return () => window.removeEventListener("cogenly:create-agent", handler);
  }, [navigate]);
  return null;
}

import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAgentCreationContext } from "./agentsClient";
import { CreateAgent } from "./AgentDetails";

export function requestAgentCreation(environmentId: EnvironmentId | null) {
  window.dispatchEvent(new CustomEvent("cogenly:create-agent", { detail: environmentId }));
}
export function AgentsCreateHost() {
  const navigate = useNavigate();
  const [target, setTarget] = useState<EnvironmentId | null>(null);
  const {
    primaryEnvironmentId: primaryId,
    projectId,
    workspaces,
  } = useAgentCreationContext(target);
  useEffect(() => {
    const handler = (event: Event) =>
      setTarget((event as CustomEvent<EnvironmentId | null>).detail ?? primaryId);
    window.addEventListener("cogenly:create-agent", handler);
    return () => window.removeEventListener("cogenly:create-agent", handler);
  }, [primaryId]);
  if (!target) return null;
  return (
    <CreateAgent
      key={target}
      environmentId={target}
      workspaces={workspaces}
      projectId={projectId}
      onClose={() => setTarget(null)}
      onCreated={(agent) => {
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: agent.environmentId, threadId: agent.conversationThreadId },
        });
      }}
    />
  );
}

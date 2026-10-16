import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import type { AgentContact } from "./agents.types";
import { useThreadShells } from "~/state/entities";
import { useAgentCreationContext, useAgents } from "./agentsClient";
import { CreateAgent } from "./AgentDetails";

export function requestAgentCreation(environmentId: EnvironmentId | null) {
  window.dispatchEvent(new CustomEvent("cogenly:create-agent", { detail: environmentId }));
}
export function AgentsCreateHost() {
  const navigate = useNavigate();
  const { agents } = useAgents();
  const threads = useThreadShells();
  const [created, setCreated] = useState<AgentContact | null>(null);
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
  // The mutation can return before either live list has consumed its update.
  // Wait for both so the new route cannot mistake this conversation for a missing thread.
  useEffect(() => {
    if (
      !created ||
      !agents.some(
        (agent) => agent.environmentId === created.environmentId && agent.id === created.id,
      ) ||
      !threads.some(
        (thread) =>
          thread.environmentId === created.environmentId &&
          thread.id === created.conversationThreadId,
      )
    )
      return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: created.environmentId, threadId: created.conversationThreadId },
    });
    setCreated(null);
  }, [created, agents, threads, navigate]);
  if (!target) return null;
  return (
    <CreateAgent
      key={target}
      environmentId={target}
      workspaces={workspaces}
      projectId={projectId}
      onClose={() => setTarget(null)}
      onCreated={setCreated}
    />
  );
}

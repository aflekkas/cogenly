import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { AgentBuilder } from "../agents/AgentBuilder";

function NewAgentRoute() {
  const { environmentId } = Route.useSearch();
  return <AgentBuilder {...(environmentId ? { environmentId } : {})} />;
}

/** Creating an agent happens here, in a conversation; see `AgentBuilder`. */
export const Route = createFileRoute("/_chat/agents/new")({
  validateSearch: (raw: Record<string, unknown>): { environmentId?: EnvironmentId } =>
    typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {},
  component: NewAgentRoute,
});

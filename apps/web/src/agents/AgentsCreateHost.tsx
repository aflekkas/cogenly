import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Every "new agent" entry point (sidebar, palette, the empty state) asks here. Creating
 * an agent is a conversation on its own screen, so the request becomes a navigation.
 */
export function requestAgentCreation(environmentId: EnvironmentId | null) {
  window.dispatchEvent(new CustomEvent("cogenly:create-agent", { detail: environmentId }));
}
export function AgentsCreateHost() {
  const navigate = useNavigate();
  useEffect(() => {
    const handler = (event: Event) => {
      const environmentId = (event as CustomEvent<EnvironmentId | null>).detail;
      void navigate({
        to: "/agents/new",
        search: environmentId ? { environmentId } : {},
      });
    };
    window.addEventListener("cogenly:create-agent", handler);
    return () => window.removeEventListener("cogenly:create-agent", handler);
  }, [navigate]);
  return null;
}

import type { EnvironmentId } from "@cogenly/contracts";
import { useRef, useState } from "react";

import { type AgentChatRequest, useStartAgentChat } from "~/hooks/useStartAgentChat";

const SETUP_STEPS =
  "Read integration_setup_guide first and follow it. Find the fastest path. Reuse existing integrations and vault clients from all paired machines first. Do browser, CLI and API setup yourself; ask me only for sign-ins, approvals and choices only I can make. Keep manual instructions collapsed. Complete setup across all paired environments in the same card. Verify the connection with integration_test when you're done.";

/**
 * The setup chat for one integration: titled for the service, or for adding one
 * when the user hasn't said which, in which case the agent asks.
 */
export function integrationSetupRequest(serviceName: string | null): AgentChatRequest {
  return serviceName === null
    ? {
        title: "Add an integration",
        prompt: `Help me connect a new service to Cogenly. Ask me which one I want, then set it up. ${SETUP_STEPS}`,
      }
    : {
        title: `Connect ${serviceName}`,
        prompt: `Connect ${serviceName} to Cogenly. ${SETUP_STEPS}`,
      };
}

/**
 * Starts an agent chat that sets up an integration and opens it. Every "connect
 * with an agent" entry point goes through here so each one opens the same chat.
 * `start` ignores calls while one is starting.
 */
export function useConnectIntegration(environmentId: EnvironmentId | null) {
  const startAgentChat = useStartAgentChat();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const start = async (request: AgentChatRequest) => {
    if (environmentId === null || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await startAgentChat(environmentId, request);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  return { pending, start };
}

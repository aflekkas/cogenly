import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AgentContacts } from "../../../agents/AgentContacts";
import { useAgents } from "../../../agents/agentsClient";
import { agentContactKey } from "../../../agents/agents.logic";

/** Every agent in one list: agents reach all projects, so none belongs under one. */
export function SidebarAgentsList(props: {
  activeThreadKey: string | null;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
  onCreateAgent: () => void;
}) {
  const { agents } = useAgents();
  const active = agents.find(
    (agent) => props.activeThreadKey === `${agent.environmentId}:${agent.conversationThreadId}`,
  );
  return (
    <AgentContacts
      activeKey={active ? agentContactKey(active) : null}
      onOpen={(agent) =>
        props.onOpenThread(scopeThreadRef(agent.environmentId, agent.conversationThreadId))
      }
      onCreate={props.onCreateAgent}
    />
  );
}

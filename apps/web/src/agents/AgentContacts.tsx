import { PlusIcon } from "lucide-react";
import { AgentFace } from "~/components/agents/face";
import { Button } from "~/components/ui/button";
import { agentContactKey, agentStatusLabel } from "./agents.logic";
import { agentAttentionCount } from "./agentWorkspace.logic";
import { useAgentUnread, useAgents } from "./agentsClient";
import type { AgentContact } from "./agents.types";

export function AgentContacts({
  activeKey,
  onOpen,
  onCreate,
}: {
  activeKey: string | null;
  onOpen: (agent: AgentContact) => void;
  onCreate: () => void;
}) {
  const { agents, loading, error } = useAgents();
  return (
    <div className="agent-contacts">
      {error && (
        <p role="alert" className="agent-error">
          {error}
        </p>
      )}
      {loading && (
        <p className="agent-empty" role="status">
          Connecting to your agents…
        </p>
      )}
      {!loading && agents.length === 0 && (
        <div className="agent-empty">
          {/* Neutral and awake: drawn in the foreground ink, with eye holes
              that show the panel behind. */}
          <AgentFace
            seed="new-friend"
            expression="neutre"
            color="currentColor"
            paper="none"
            size={48}
            className="text-foreground/90"
          />
          <p>No agents yet</p>
          <span>Create an agent to talk to, give work to, and hear back from.</span>
          <Button size="sm" onClick={onCreate}>
            <PlusIcon aria-hidden />
            Create your first agent
          </Button>
        </div>
      )}
      <ul aria-label="Agents">
        {agents.map((agent) => (
          <Contact
            key={agentContactKey(agent)}
            agent={agent}
            active={activeKey === agentContactKey(agent)}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </div>
  );
}
function Contact({
  agent,
  active,
  onOpen,
}: {
  agent: AgentContact;
  active: boolean;
  onOpen: (agent: AgentContact) => void;
}) {
  const unread = useAgentUnread(agent);
  const status = agentStatusLabel(agent);
  // Only decisions waiting on the owner earn a count; unread replies get a dot.
  const attention = agentAttentionCount(agent);
  return (
    <li>
      <button
        type="button"
        className={active ? "agent-contact state-selected" : "agent-contact state-hover"}
        data-active={active}
        aria-current={active ? "page" : undefined}
        onClick={() => onOpen(agent)}
      >
        <AgentFace
          seed={agent.avatar.seed}
          {...(agent.avatar.color ? { color: agent.avatar.color } : {})}
          state={agent.state}
          size={28}
        />
        <span className="agent-contact-copy">
          <span className="agent-contact-name">
            <span>{agent.name}</span>
            <small className="agent-contact-status" data-status={status}>
              {status}
            </small>
          </span>
          <span className="agent-contact-preview">
            <span>{agent.preview || "Say hello"}</span>
            {attention > 0 ? (
              <span className="agent-unread" aria-label={`${attention} waiting on you`}>
                {attention > 99 ? "99+" : attention}
              </span>
            ) : unread > 0 ? (
              <span className="agent-unread-dot" aria-label="Unread reply" />
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}

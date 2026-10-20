import { AgentFace } from "~/components/agents/face";
import { avatarFaceProps } from "~/components/agents/face/agentAvatar.logic";
import { agentContactKey, agentStatusLabel } from "./agents.logic";
import { agentAttentionCount } from "./agentWorkspace.logic";
import { useAgentUnread, useAgents } from "./agentsClient";
import type { AgentContact } from "./agents.types";

export function AgentContacts({
  activeKey,
  onOpen,
}: {
  activeKey: string | null;
  onOpen: (agent: AgentContact) => void;
  /** Unused since the empty state moved to the index route; kept so callers stay stable. */
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
      {/* With no agents the list column is hidden and the index route shows
          the one empty state, so nothing is rendered here for that case. */}
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
        <AgentFace {...avatarFaceProps(agent.avatar)} state={agent.state} size={28} />
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

import { Fragment, type ReactNode } from "react";
import { AgentFace } from "~/components/agents/face";
import { agentContactKey, formatContactTime } from "./agents.logic";
import { useAgentUnread, useAgents } from "./agentsClient";
import type { AgentContact } from "./agents.types";

export function AgentContacts({
  activeKey,
  onOpen,
  onCreate,
  groups,
}: {
  activeKey: string | null;
  onOpen: (agent: AgentContact) => void;
  onCreate: () => void;
  groups?: ReadonlyArray<{ key: string; heading?: ReactNode; agents: ReadonlyArray<AgentContact> }>;
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
          <AgentFace seed="new-friend" state="asleep" size={48} />
          <p>A little help, always close.</p>
          <span>Create an agent to talk to, give work to, and hear back from.</span>
          <button className="agent-text-button" type="button" onClick={onCreate}>
            Create your first agent
          </button>
        </div>
      )}
      <ul aria-label="Agents">
        {(groups ?? [{ key: "all", agents }]).map((group) => (
          <Fragment key={group.key}>
            {group.heading}
            {group.agents.map((agent) => (
              <Contact
                key={agentContactKey(agent)}
                agent={agent}
                active={activeKey === agentContactKey(agent)}
                onOpen={onOpen}
              />
            ))}
          </Fragment>
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
  return (
    <li>
      <button
        type="button"
        className={`agent-contact ${active ? "surface-raised-sm" : "hover:surface-raised-hover"}`}
        data-active={active}
        aria-current={active ? "page" : undefined}
        onClick={() => onOpen(agent)}
      >
        <AgentFace
          seed={agent.avatar.seed}
          {...(agent.avatar.color ? { color: agent.avatar.color } : {})}
          state={agent.state}
          size={38}
        />
        <span className="agent-contact-copy">
          <span className="agent-contact-name">
            {agent.name}
            <time dateTime={agent.updatedAt}>{formatContactTime(agent.updatedAt)}</time>
          </span>
          <span className="agent-contact-preview">
            <span>{agent.preview || "Say hello"}</span>
            {unread > 0 && (
              <span className="agent-unread" aria-label={`${unread} unread messages`}>
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

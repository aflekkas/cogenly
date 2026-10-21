import { useState } from "react";
import { AgentFace } from "~/components/agents/face";
import { avatarFaceProps } from "~/components/agents/face/agentAvatar.logic";
import { cn } from "~/lib/utils";
import { formatRelativeTime } from "~/timestampFormat";
import { takeAgentArrival } from "./agentArrivals";
import { agentContactKey, agentStatusLabel, type AgentStatusLabel } from "./agents.logic";
import { agentAttentionCount } from "./agentWorkspace.logic";
import { useAgentUnread, useAgents } from "./agentsClient";
import type { AgentContact } from "./agents.types";

const DOT_CLASS: Record<AgentStatusLabel, string> = {
  "Needs approval": "bg-warning-foreground",
  "Needs you": "bg-warning-foreground",
  Running: "bg-info",
  Idle: "bg-muted-foreground/35",
};

/** The agent's status as a dot, named for assistive tech. */
export function AgentStatusDot({ status }: { status: AgentStatusLabel }) {
  return (
    <span
      key={status}
      role="img"
      aria-label={status}
      className={cn("swap-motion size-2 shrink-0 rounded-full", DOT_CLASS[status])}
    />
  );
}

/** The Agents list: one slim row per agent, like a chat row. */
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
    <div className="flex w-full flex-1 flex-col">
      {error && (
        <p role="alert" className="agent-error">
          {error}
        </p>
      )}
      {loading && (
        <p
          role="status"
          className="flex flex-1 items-center justify-center px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
        >
          Connecting to your agents…
        </p>
      )}
      {/* With no agents the list column is hidden and the index route shows
          the one empty state, so nothing is rendered here for that case. */}
      <ul aria-label="Agents" data-agents-list className="flex flex-col gap-1">
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
  // A row for an agent made in this session rises into place once, when it first mounts.
  const [arrived] = useState(() => takeAgentArrival(agentContactKey(agent)));
  const since = formatRelativeTime(agent.updatedAt);
  return (
    <li className="list-none">
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        aria-label={`${agent.name}, ${status}`}
        onClick={() => onOpen(agent)}
        className={cn(
          "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-rail px-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          active ? "state-selected" : "state-hover",
          arrived && "swap-motion",
        )}
      >
        <AgentFace {...avatarFaceProps(agent.avatar)} state={agent.state} size={22} />
        <span className="min-w-0 flex-1 truncate">{agent.name}</span>
        {attention > 0 ? (
          <span
            className="inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-2xs font-semibold text-primary-foreground tabular-nums"
            aria-label={`${attention} waiting on you`}
          >
            {attention > 99 ? "99+" : attention}
          </span>
        ) : unread > 0 ? (
          <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread reply" />
        ) : null}
        <AgentStatusDot status={status} />
        {since && (
          <span className="shrink-0 text-xs text-secondary-label tabular-nums">{since.value}</span>
        )}
      </button>
    </li>
  );
}

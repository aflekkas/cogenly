import { BellDotIcon } from "lucide-react";
import { SidebarSegmentBar } from "~/components/sidebar/SidebarShelfBar";
import { SIDEBAR_MODE_ICONS } from "~/components/sidebar/modes/SidebarModeSwitcher";
import { useSegmentSelection } from "~/components/sidebar/sidebarSegments.logic";
import { setAgentListFilter, useAgentListFilter, type AgentListFilter } from "./agentListFilter";
import { agentAttentionCount } from "./agentWorkspace.logic";
import { useAgents } from "./agentsClient";

const AGENT_FILTER_ORDER: ReadonlyArray<AgentListFilter> = ["all", "attention"];

/**
 * The Agents filter the list shows: the one chosen, unless it holds nothing,
 * when it falls back to All agents (see `useSegmentSelection`). The list and
 * its count bar both read it, so neither opens onto an empty filter.
 */
export function useShownAgentListFilter() {
  const { agents, loading, reconnecting } = useAgents();
  const filter = useAgentListFilter();
  const attention = agents.filter((agent) => agentAttentionCount(agent) > 0).length;
  // While a machine is still loading or re-fetching, a count is not a zero.
  const pending = (loading || reconnecting) && agents.length === 0;
  const index = useSegmentSelection(
    pending ? [null, null] : [agents.length, attention],
    AGENT_FILTER_ORDER.indexOf(filter),
    (fallback) => setAgentListFilter(AGENT_FILTER_ORDER[fallback] ?? "all"),
  );
  return {
    filter: AGENT_FILTER_ORDER[index] ?? "all",
    total: agents.length,
    attention,
    pending,
  };
}

/** The Agents column's count bar: all agents, and the ones waiting on you. */
export function AgentsShelfBar() {
  const { filter, total, attention, pending } = useShownAgentListFilter();
  return (
    <SidebarSegmentBar
      ariaLabel="Agent lists"
      segments={[
        {
          icon: SIDEBAR_MODE_ICONS.agents,
          label: "All agents",
          count: total,
          pending,
          emptyLabel: "No agents yet",
        },
        {
          icon: BellDotIcon,
          label: "Needs attention",
          count: attention,
          highlight: true,
          pending,
          emptyLabel: "No agent needs you",
        },
      ]}
      selectedIndex={AGENT_FILTER_ORDER.indexOf(filter)}
      onSelect={(index) => setAgentListFilter(AGENT_FILTER_ORDER[index] ?? "all")}
    />
  );
}

import { BellDotIcon } from "lucide-react";
import { SidebarSegmentBar } from "~/components/sidebar/SidebarShelfBar";
import { SIDEBAR_MODE_ICONS } from "~/components/sidebar/modes/SidebarModeSwitcher";
import { setAgentListFilter, useAgentListFilter } from "./agentListFilter";
import { agentAttentionCount } from "./agentWorkspace.logic";
import { useAgents } from "./agentsClient";

/** The Agents column's count bar: all agents, and the ones waiting on you. */
export function AgentsShelfBar() {
  const { agents } = useAgents();
  const filter = useAgentListFilter();
  const attention = agents.filter((agent) => agentAttentionCount(agent) > 0).length;
  return (
    <SidebarSegmentBar
      ariaLabel="Agent lists"
      segments={[
        { icon: SIDEBAR_MODE_ICONS.agents, label: "All agents", count: agents.length },
        { icon: BellDotIcon, label: "Needs attention", count: attention, highlight: true },
      ]}
      selectedIndex={filter === "attention" ? 1 : 0}
      onSelect={(index) => setAgentListFilter(index === 1 ? "attention" : "all")}
    />
  );
}

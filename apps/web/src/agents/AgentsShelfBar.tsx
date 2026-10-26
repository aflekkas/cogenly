import type { EnvironmentId } from "@cogenly/contracts";
import { BellDotIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { SidebarSegmentBar } from "~/components/sidebar/SidebarShelfBar";
import { SIDEBAR_MODE_ICONS } from "~/components/sidebar/modes/SidebarModeSwitcher";
import { useSidebarProjectFilter } from "~/components/sidebar/sidebarProjectFilter";
import {
  resolveSidebarProjectFilter,
  sidebarProjectFilterValue,
} from "~/components/sidebar/sidebarProjectFilter.logic";
import { useSegmentSelection } from "~/components/sidebar/sidebarSegments.logic";
import { projectLabelKey } from "~/projectLabels/projectLabels.logic";
import { useProjectLabelDirectory } from "~/projectLabels/useProjectLabels";
import { setAgentListFilter, useAgentListFilter, type AgentListFilter } from "./agentListFilter";
import { agentAttentionCount } from "./agentWorkspace.logic";
import { useAgents } from "./agentsClient";
import type { AgentContact } from "./agents.types";

const AGENT_FILTER_ORDER: ReadonlyArray<AgentListFilter> = ["all", "attention"];

/**
 * The dock's project filter as Agents applies it, over the projects on the
 * agents' machines: `inProject` keeps the agents it holds.
 */
export function useAgentProjectFilter(agents: ReadonlyArray<AgentContact>) {
  const environmentKey = [...new Set(agents.map((agent) => agent.environmentId))].join("\0");
  const environmentIds = useMemo(
    () => (environmentKey === "" ? [] : (environmentKey.split("\0") as EnvironmentId[])),
    [environmentKey],
  );
  const directory = useProjectLabelDirectory(environmentIds);
  const projectFilter = resolveSidebarProjectFilter(
    useSidebarProjectFilter("agents"),
    directory.byKey,
  );
  const inProject = useCallback(
    (agent: AgentContact) =>
      projectFilter === null ||
      sidebarProjectFilterValue(
        agent.projectFolderId === null
          ? null
          : (directory.byKey.get(projectLabelKey(agent.environmentId, agent.projectFolderId)) ??
              null),
      ) === projectFilter,
    [directory.byKey, projectFilter],
  );
  return { directory, projectFilter, inProject };
}

/**
 * The Agents filter the list shows: the one chosen, unless it holds nothing,
 * when it falls back to All agents (see `useSegmentSelection`). The list and
 * its count bar both read it, so neither opens onto an empty filter. Both
 * count inside the dock's project filter.
 */
export function useShownAgentListFilter() {
  const { agents: allAgents, loading, reconnecting } = useAgents();
  const { inProject, projectFilter } = useAgentProjectFilter(allAgents);
  const agents = useMemo(
    () => (projectFilter === null ? allAgents : allAgents.filter(inProject)),
    [allAgents, inProject, projectFilter],
  );
  const filter = useAgentListFilter();
  const attention = agents.filter((agent) => agentAttentionCount(agent) > 0).length;
  // While a machine is still loading or re-fetching, a count is not a zero.
  const pending = (loading || reconnecting) && allAgents.length === 0;
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

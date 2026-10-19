import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useMemo } from "react";
import { useConnectedEnvironmentIds } from "~/state/environments";
import { ProjectColorDot } from "~/projectLabels/ProjectTag";
import { projectLabelKey } from "~/projectLabels/projectLabels.logic";
import { useProjectLabelDirectory } from "~/projectLabels/useProjectLabels";
import { SidebarModeGroupLabel } from "./SidebarModeGroupLabel";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AgentContacts } from "../../../agents/AgentContacts";
import { useAgents } from "../../../agents/agentsClient";
import { agentContactKey } from "../../../agents/agents.logic";
import { groupAgentsByScope } from "../../../agents/agentWorkspace.logic";

/**
 * Agents grouped under the projects their scope grants: an agent in two projects
 * appears under both, unscoped agents under "Other". Without any scoped agent the
 * list has no headings.
 */
export function SidebarAgentsList(props: {
  activeThreadKey: string | null;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
  onCreateAgent: () => void;
}) {
  const { agents } = useAgents();
  const directory = useProjectLabelDirectory(useConnectedEnvironmentIds());
  const sections = useMemo(
    () =>
      groupAgentsByScope(agents, (agent) =>
        agent.scope.flatMap((entry) => {
          const project = directory.byKey.get(projectLabelKey(agent.environmentId, entry.labelId));
          return project
            ? [{ key: project.key, name: project.label.name, color: project.label.color }]
            : [];
        }),
      ),
    [agents, directory],
  );
  const active = agents.find(
    (agent) => props.activeThreadKey === `${agent.environmentId}:${agent.conversationThreadId}`,
  );
  return (
    <AgentContacts
      groups={sections.map((section) => ({
        key: section.project?.key ?? "other",
        agents: section.agents,
        heading:
          sections.length === 1 && section.project === null ? null : (
            <SidebarModeGroupLabel
              icon={section.project ? <ProjectColorDot color={section.project.color} /> : null}
            >
              {section.project?.name ?? "Other"}
            </SidebarModeGroupLabel>
          ),
      }))}
      activeKey={active ? agentContactKey(active) : null}
      onOpen={(agent) =>
        props.onOpenThread(scopeThreadRef(agent.environmentId, agent.conversationThreadId))
      }
      onCreate={props.onCreateAgent}
    />
  );
}

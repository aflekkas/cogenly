import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { useProjects, useServerConfigs } from "~/state/entities";
import { ProjectFavicon } from "../../ProjectFavicon";
import { SidebarModeGroupLabel } from "./SidebarModeGroupLabel";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AgentContacts } from "../../../agents/AgentContacts";
import { useAgents } from "../../../agents/agentsClient";
import { agentContactKey, groupAgentContacts } from "../../../agents/agents.logic";

/** Agents are contacts, grouped by project with no-project contacts first. */
export function SidebarAgentsList(props: {
  activeThreadKey: string | null;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
  onCreateAgent: () => void;
}) {
  const { agents } = useAgents();
  const projects = useProjects();
  const configs = useServerConfigs();
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  const groups = groupAgentContacts(agents, (agent) => {
    if (!agent.projectId) return null;
    const key = `${agent.environmentId}:${agent.projectId}`;
    const project = projectByKey.get(key);
    if (
      project &&
      (project.isScratch ||
        isScratchProject(project, configs.get(agent.environmentId)?.scratchWorkspaceRoot))
    )
      return null;
    return { key, label: props.projectDisplayNameByKey.get(key) ?? project?.title ?? "Project" };
  });
  const active = agents.find(
    (agent) => props.activeThreadKey === `${agent.environmentId}:${agent.conversationThreadId}`,
  );
  return (
    <AgentContacts
      groups={groups.map((group) => {
        const project = projectByKey.get(group.key);
        return {
          ...group,
          heading:
            group.label === null ? null : (
              <SidebarModeGroupLabel
                icon={
                  project ? (
                    <ProjectFavicon project={project} className="size-3.5 shrink-0" />
                  ) : null
                }
              >
                {group.label}
              </SidebarModeGroupLabel>
            ),
        };
      })}
      activeKey={active ? agentContactKey(active) : null}
      onOpen={(agent) =>
        props.onOpenThread(scopeThreadRef(agent.environmentId, agent.conversationThreadId))
      }
      onCreate={props.onCreateAgent}
    />
  );
}

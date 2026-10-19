import { useMemo } from "react";

import { useAgents } from "../agents/agentsClient";
import { filterSidebarV2VisibleThreads } from "../components/Sidebar.logic";
import {
  sidebarModeForThread,
  sortChatsByActivity,
} from "../components/sidebar/modes/sidebarModes.logic";
import { useSidebarModeClassifier } from "../components/sidebar/modes/useSidebarModeState";
import { useSidebarProjectGroups } from "../hooks/useSidebarProjectGroups";
import { useProjects, useServerConfigs, useThreadShells } from "../state/entities";
import { useConnectedEnvironmentIds } from "../state/environments";
import { indexProjectContents } from "./projectContents.logic";
import {
  projectLabelKey,
  scopedRepositoryKey,
  scopedThreadTagKey,
  workRowProjectTags,
} from "./projectLabels.logic";
import { useProjectLabelDirectory } from "./useProjectLabels";

/**
 * Projects with the Work, chats and agents filed under each, newest
 * activity first. Work files the same way its sidebar chips read.
 */
export function useProjectContents() {
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const { agents } = useAgents();
  const projectGroups = useSidebarProjectGroups();
  const directory = useProjectLabelDirectory(useConnectedEnvironmentIds());
  const { classifier } = useSidebarModeClassifier({ threads, projects, serverConfigs });
  const byProject = useMemo(() => {
    // A logical repository spans its checkouts on every machine.
    const repositoryKeysByKey = new Map<string, string[]>();
    for (const group of projectGroups) {
      const keys = group.memberProjectRefs.map((ref) =>
        scopedRepositoryKey(ref.environmentId, ref.projectId),
      );
      for (const key of keys) repositoryKeysByKey.set(key, keys);
    }
    return indexProjectContents({
      threads: sortChatsByActivity(filterSidebarV2VisibleThreads(threads, null)),
      modeOf: (thread) => sidebarModeForThread(thread, classifier),
      workProjectKeys: (thread) => {
        const repositoryKey = scopedRepositoryKey(thread.environmentId, thread.projectId);
        return workRowProjectTags(
          directory.confirmedByThread.get(scopedThreadTagKey(thread.environmentId, thread.id)) ??
            [],
          repositoryKeysByKey.get(repositoryKey) ?? [repositoryKey],
          directory,
        ).map((tag) => tag.key);
      },
      chatProjectKeys: (thread) =>
        directory.confirmedByThread.get(scopedThreadTagKey(thread.environmentId, thread.id)) ?? [],
      agents,
      agentProjectKeys: (agent) =>
        agent.scope.map((entry) => projectLabelKey(agent.environmentId, entry.labelId)),
    });
  }, [agents, classifier, directory, projectGroups, threads]);
  return { directory, byProject };
}

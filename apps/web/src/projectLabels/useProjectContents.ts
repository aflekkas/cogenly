import { useMemo } from "react";

import { filterSidebarV2VisibleThreads } from "../components/Sidebar.logic";
import {
  sidebarModeForThread,
  sortChatsByActivity,
} from "../components/sidebar/modes/sidebarModes.logic";
import { useSidebarModeClassifier } from "../components/sidebar/modes/useSidebarModeState";
import { useProjects, useServerConfigs, useThreadShells } from "../state/entities";
import { useConnectedEnvironmentIds } from "../state/environments";
import { indexProjectContents } from "./projectContents.logic";
import { projectLabelKey, threadProjectFolderId } from "./projectLabels.logic";
import { useProjectLabelDirectory } from "./useProjectLabels";

/**
 * Folders with the chats and Work filed in each, newest activity first,
 * across every connected machine and keyed by each project's one entry. A
 * thread's folder comes from its shell, so this needs no membership query.
 */
export function useProjectContents() {
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const directory = useProjectLabelDirectory(useConnectedEnvironmentIds());
  const { classifier } = useSidebarModeClassifier({ threads, projects, serverConfigs });
  const byProject = useMemo(
    () =>
      indexProjectContents({
        threads: sortChatsByActivity(filterSidebarV2VisibleThreads(threads, null)),
        modeOf: (thread) => sidebarModeForThread(thread, classifier),
        folderKeyOf: (thread) => {
          const folderId = threadProjectFolderId(thread);
          if (folderId === null) return null;
          // Any machine's copy of a project files into its one entry.
          return directory.byKey.get(projectLabelKey(thread.environmentId, folderId))?.key ?? null;
        },
      }),
    [classifier, directory, threads],
  );
  return { directory, byProject };
}

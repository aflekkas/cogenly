import { useMemo } from "react";

import { useAgents } from "../../../agents/agentsClient";
import { useProjects, useServerConfigs, useThreadShells } from "../../../state/entities";
import { modesNeedingAttention } from "./modeAttention.logic";
import { SIDEBAR_MODES, type SidebarMode } from "./sidebarModes.logic";
import { useSidebarModeClassifier } from "./useSidebarModeState";

const NO_MODES: ReadonlySet<SidebarMode> = new Set();

/**
 * The modes with something waiting on you, read from the same stores as the
 * sidebar so it is live wherever the mode switch renders (the navigation rail,
 * the mobile sheet). The set keeps its identity until the answer changes, so a
 * shell update that leaves the dots alone re-renders nothing downstream.
 */
export function useModesNeedingAttention(): ReadonlySet<SidebarMode> {
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const { agents } = useAgents();
  const { classifier } = useSidebarModeClassifier({ threads, projects, serverConfigs });
  const key = useMemo(() => {
    const modes = modesNeedingAttention({
      threads,
      classifier,
      agents,
      capabilities: (environmentId) => serverConfigs.get(environmentId)?.environment.capabilities,
      now: new Date().toISOString(),
    });
    return SIDEBAR_MODES.filter((mode) => modes.has(mode)).join(",");
  }, [agents, classifier, serverConfigs, threads]);
  return useMemo(() => (key === "" ? NO_MODES : new Set(key.split(",") as SidebarMode[])), [key]);
}

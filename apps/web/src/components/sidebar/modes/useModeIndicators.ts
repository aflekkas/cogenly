import { scopeThreadRef, scopedThreadKey } from "@cogenly/client-runtime/environment";
import { useMemo } from "react";

import { useAgents } from "../../../agents/agentsClient";
import { useProjects, useServerConfigs, useThreadShells } from "../../../state/entities";
import { useUiStateStore } from "../../../uiStateStore";
import { resolveThreadLastVisitedAt } from "../../Sidebar.logic";
import { modeIndicators, type ModeIndicatorTone } from "./modeIndicators.logic";
import { SIDEBAR_MODES, type SidebarMode } from "./sidebarModes.logic";
import { useSidebarModeClassifier } from "./useSidebarModeState";

const NO_MODES: ReadonlyMap<SidebarMode, ModeIndicatorTone> = new Map();

/**
 * Each mode's dot (amber needs you, blue unread), read from the same stores as
 * the sidebar so it is live wherever the mode switch renders (the navigation
 * rail, the mobile sheet). The map keeps its identity until the answer
 * changes, so a shell update that leaves the dots alone re-renders nothing
 * downstream.
 */
export function useModeIndicators(): ReadonlyMap<SidebarMode, ModeIndicatorTone> {
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const { agents } = useAgents();
  const { classifier } = useSidebarModeClassifier({ threads, projects, serverConfigs });
  const key = useMemo(() => {
    const modes = modeIndicators({
      threads,
      classifier,
      agents,
      capabilities: (environmentId) => serverConfigs.get(environmentId)?.environment.capabilities,
      lastVisitedAt: (thread) =>
        resolveThreadLastVisitedAt(
          thread.lastVisitedAt,
          localLastVisitedAtById[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
        ),
      now: new Date().toISOString(),
    });
    return SIDEBAR_MODES.flatMap((mode) => {
      const tone = modes.get(mode);
      return tone ? [`${mode}:${tone}`] : [];
    }).join(",");
  }, [agents, classifier, localLastVisitedAtById, serverConfigs, threads]);
  return useMemo(
    () =>
      key === ""
        ? NO_MODES
        : new Map(
            key.split(",").map((entry) => {
              const [mode, tone] = entry.split(":") as [SidebarMode, ModeIndicatorTone];
              return [mode, tone] as const;
            }),
          ),
    [key],
  );
}

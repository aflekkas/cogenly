import type { EnvironmentId, ProjectLabelId } from "@t3tools/contracts";

import {
  projectLabelKey,
  sortProjectLabels,
  type EnvironmentProjectLabel,
} from "../projectLabels/projectLabels.logic";

/** The group for agents filed in no project, or in a folder that no longer exists. */
export const NO_PROJECT_GROUP_KEY = "no-project";

export interface AgentProjectGroup<A> {
  /** The folder's `environmentId:labelId`, or `NO_PROJECT_GROUP_KEY`. */
  readonly key: string;
  /** Null for the No project group. */
  readonly folder: EnvironmentProjectLabel | null;
  readonly agents: ReadonlyArray<A>;
}

export interface AgentProjectGroups<A> {
  /** False when no shown agent is in a known project: the list stays flat, without headers. */
  readonly grouped: boolean;
  readonly groups: ReadonlyArray<AgentProjectGroup<A>>;
}

/**
 * The Agents list by project folder: the list filter first, then one group
 * per folder in name order (as the Work picker orders projects), and No
 * project last. Agents keep their order inside a group, and a group with no
 * agent left after the filter is dropped.
 */
export function groupAgentsByProject<
  A extends {
    readonly environmentId: EnvironmentId;
    readonly projectFolderId: ProjectLabelId | null;
  },
>(input: {
  readonly agents: ReadonlyArray<A>;
  readonly folders: ReadonlyArray<EnvironmentProjectLabel>;
  /** The list filter (Needs attention); agents it rejects are left out before grouping. */
  readonly include?: ((agent: A) => boolean) | undefined;
}): AgentProjectGroups<A> {
  const shown = input.include ? input.agents.filter(input.include) : input.agents;
  const folders = new Map(input.folders.map((folder) => [folder.key as string, folder]));
  const byFolder = new Map<string, A[]>();
  const unfiled: A[] = [];
  for (const agent of shown) {
    const key =
      agent.projectFolderId === null
        ? null
        : projectLabelKey(agent.environmentId, agent.projectFolderId);
    if (key === null || !folders.has(key)) {
      unfiled.push(agent);
      continue;
    }
    const list = byFolder.get(key);
    if (list) list.push(agent);
    else byFolder.set(key, [agent]);
  }
  const groups: AgentProjectGroup<A>[] = sortProjectLabels(
    [...byFolder.keys()].map((key) => folders.get(key)!),
  ).map((folder) => ({ key: folder.key, folder, agents: byFolder.get(folder.key)! }));
  const grouped = groups.length > 0;
  if (unfiled.length > 0) groups.push({ key: NO_PROJECT_GROUP_KEY, folder: null, agents: unfiled });
  return { grouped, groups };
}

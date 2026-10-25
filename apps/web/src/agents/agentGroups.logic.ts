import type { EnvironmentId, ProjectLabelId } from "@cogenly/contracts";

import {
  projectLabelEnvironmentIds,
  projectLabelKey,
  sortProjectLabels,
  type EnvironmentProjectLabel,
} from "../projectLabels/projectLabels.logic";

/**
 * The Agents list's order, top to bottom: agents never arranged first, in the
 * order they came in (most recent first), then arranged agents by their order
 * key. A drag or alt+arrow writes keys with `planPinnedReorder` over a group's
 * drawn order, so keys rise down the list and a new agent leads its group.
 */
export function orderAgentsForList<A extends { readonly orderKey?: string | null | undefined }>(
  agents: ReadonlyArray<A>,
): A[] {
  const keyless = agents.filter((agent) => agent.orderKey == null);
  const keyed = agents
    .filter((agent) => agent.orderKey != null)
    .toSorted((left, right) =>
      left.orderKey! < right.orderKey! ? -1 : left.orderKey! > right.orderKey! ? 1 : 0,
    );
  return [...keyless, ...keyed];
}

/**
 * One contact per agent across connected machines. Agents sync under one id,
 * so each paired machine lists a copy; the owner machine's copy (where its
 * conversation runs) wins, else the first, in the first copy's place.
 */
export function onePerAgent<
  A extends {
    readonly id: string;
    readonly environmentId: EnvironmentId;
    readonly ownerMachine?: EnvironmentId | undefined;
  },
>(agents: ReadonlyArray<A>): A[] {
  const slot = new Map<string, number>();
  const kept: A[] = [];
  for (const agent of agents) {
    const index = slot.get(agent.id);
    if (index === undefined) {
      slot.set(agent.id, kept.length);
      kept.push(agent);
    } else if ((agent.ownerMachine ?? agent.environmentId) === agent.environmentId) {
      kept[index] = agent;
    }
  }
  return kept;
}

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
  // Every machine's key for a folder leads to it.
  const folders = new Map<string, EnvironmentProjectLabel>();
  for (const folder of input.folders) {
    for (const environmentId of projectLabelEnvironmentIds(folder)) {
      folders.set(projectLabelKey(environmentId, folder.label.id), folder);
    }
  }
  const byFolder = new Map<string, A[]>();
  const unfiled: A[] = [];
  for (const agent of shown) {
    const key =
      agent.projectFolderId === null
        ? null
        : (folders.get(projectLabelKey(agent.environmentId, agent.projectFolderId))?.key ?? null);
    if (key === null) {
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

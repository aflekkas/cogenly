import type { EnvironmentId, ProjectLabelWithRepositories } from "@cogenly/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomValueOverBuiltSources } from "../state/useAtomValueBuiltOutsideRender";
import {
  partitionArchivedProjectLabels,
  unifyProjectLabels,
  type EnvironmentProjectLabel,
  type ProjectLabelKey,
} from "./projectLabels.logic";

const EMPTY_LABELS: ReadonlyArray<ProjectLabelWithRepositories> = [];

/** One environment's projects, live. */
export function useEnvironmentProjectLabels(environmentId: EnvironmentId | null) {
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.projectLabelsLive({ environmentId, input: {} }),
  );
  return {
    labels: query.data?.labels ?? EMPTY_LABELS,
    error: query.error,
    isLoaded: query.data !== null,
  };
}

export interface ProjectLabelDirectory {
  /**
   * Every project on the given environments, one entry per project however
   * many machines have it, archived ones included, alphabetical. For naming
   * what a thread is filed in; pickers use `active`.
   */
  readonly labels: ReadonlyArray<EnvironmentProjectLabel>;
  /** The folders that are not archived: what pickers and move menus offer. */
  readonly active: ReadonlyArray<EnvironmentProjectLabel>;
  /** Archived folders, for the Projects list's Archived filter. */
  readonly archived: ReadonlyArray<EnvironmentProjectLabel>;
  /** Any machine's `projectLabelKey` for a project → its one entry. */
  readonly byKey: ReadonlyMap<ProjectLabelKey, EnvironmentProjectLabel>;
  /** `environmentId:repositoryId` → the one folder holding that repository. */
  readonly folderByRepository: ReadonlyMap<string, EnvironmentProjectLabel>;
}

const EMPTY_DIRECTORY: ProjectLabelDirectory = {
  labels: [],
  active: [],
  archived: [],
  byKey: new Map(),
  folderByRepository: new Map(),
};
const EMPTY_DIRECTORY_ATOM = Atom.make(EMPTY_DIRECTORY).pipe(
  Atom.withLabel("project-label-directory:empty"),
);

/**
 * Folders and the repositories in each, across environments, from one live
 * stream per environment. Which folder a thread is in rides on its shell
 * (`threadProjectFolderId`). An environment still loading or failed
 * contributes nothing.
 */
export function useProjectLabelDirectory(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ProjectLabelDirectory {
  const idsKey = environmentIds.join("\0");
  const atom = useMemo(
    () =>
      idsKey === ""
        ? EMPTY_DIRECTORY_ATOM
        : Atom.make((get): ProjectLabelDirectory => {
            // The primary machine speaks for a project it has.
            const primary = get(primaryEnvironmentIdAtom);
            const ids = (idsKey.split("\0") as EnvironmentId[]).toSorted(
              (left, right) => Number(right === primary) - Number(left === primary),
            );
            const perEnvironment = ids.map((environmentId) => ({
              environmentId,
              labels:
                Option.getOrNull(
                  AsyncResult.value(
                    get(serverEnvironment.projectLabelsLive({ environmentId, input: {} })),
                  ),
                )?.labels ?? EMPTY_LABELS,
            }));
            const { labels, byKey, folderByRepository } = unifyProjectLabels(perEnvironment);
            if (labels.length === 0) return EMPTY_DIRECTORY;
            const { active, archived } = partitionArchivedProjectLabels(labels);
            return { labels, active, archived, byKey, folderByRepository };
          }).pipe(Atom.withLabel("project-label-directory")),
    [idsKey],
  );
  // The live streams it reads are built outside render: opening a stream for
  // an environment no one watched yet updates other components' atoms.
  const sources = useMemo(
    () =>
      idsKey === ""
        ? []
        : (idsKey.split("\0") as EnvironmentId[]).map((environmentId) =>
            serverEnvironment.projectLabelsLive({ environmentId, input: {} }),
          ),
    [idsKey],
  );
  return useAtomValueOverBuiltSources(atom, sources, EMPTY_DIRECTORY_ATOM);
}

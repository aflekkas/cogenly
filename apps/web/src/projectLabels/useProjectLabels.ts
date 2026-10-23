import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectLabelWithRepositories } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import {
  partitionArchivedProjectLabels,
  projectLabelKey,
  scopedRepositoryKey,
  sortProjectLabels,
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
   * Every folder on the given environments, archived ones included,
   * alphabetical. For naming what a thread is filed in; pickers use `active`.
   */
  readonly labels: ReadonlyArray<EnvironmentProjectLabel>;
  /** The folders that are not archived: what pickers and move menus offer. */
  readonly active: ReadonlyArray<EnvironmentProjectLabel>;
  /** Archived folders, for the Projects list's Archived filter. */
  readonly archived: ReadonlyArray<EnvironmentProjectLabel>;
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
            const labels: EnvironmentProjectLabel[] = [];
            for (const environmentId of idsKey.split("\0") as EnvironmentId[]) {
              const list = Option.getOrNull(
                AsyncResult.value(
                  get(serverEnvironment.projectLabelsLive({ environmentId, input: {} })),
                ),
              );
              for (const label of list?.labels ?? []) {
                labels.push({
                  key: projectLabelKey(environmentId, label.id),
                  environmentId,
                  label,
                });
              }
            }
            if (labels.length === 0) return EMPTY_DIRECTORY;
            const sorted = sortProjectLabels(labels);
            const byKey = new Map(sorted.map((entry) => [entry.key, entry] as const));
            const folderByRepository = new Map<string, EnvironmentProjectLabel>();
            for (const entry of sorted) {
              for (const repositoryId of entry.label.repositoryIds) {
                folderByRepository.set(
                  scopedRepositoryKey(entry.environmentId, repositoryId),
                  entry,
                );
              }
            }
            const { active, archived } = partitionArchivedProjectLabels(sorted);
            return { labels: sorted, active, archived, byKey, folderByRepository };
          }).pipe(Atom.withLabel("project-label-directory")),
    [idsKey],
  );
  return useAtomValue(atom);
}

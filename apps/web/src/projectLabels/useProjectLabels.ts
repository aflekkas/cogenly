import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectLabelWithRepositories } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import {
  projectLabelKey,
  scopedRepositoryKey,
  scopedThreadTagKey,
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
  /** Every project on the given environments, alphabetical. */
  readonly labels: ReadonlyArray<EnvironmentProjectLabel>;
  readonly byKey: ReadonlyMap<ProjectLabelKey, EnvironmentProjectLabel>;
  /** `environmentId:repositoryId` → the projects linking that repository. */
  readonly projectsByRepository: ReadonlyMap<string, ReadonlyArray<EnvironmentProjectLabel>>;
  /** `environmentId:threadId` → confirmed project keys, alphabetical by name. */
  readonly confirmedByThread: ReadonlyMap<string, ReadonlyArray<ProjectLabelKey>>;
}

const EMPTY_DIRECTORY: ProjectLabelDirectory = {
  labels: [],
  byKey: new Map(),
  projectsByRepository: new Map(),
  confirmedByThread: new Map(),
};
const EMPTY_DIRECTORY_ATOM = Atom.make(EMPTY_DIRECTORY).pipe(
  Atom.withLabel("project-label-directory:empty"),
);

/**
 * Projects, their repository links, and confirmed thread tags across
 * environments, from two live streams per environment (not one per row).
 * An environment still loading or failed contributes nothing.
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
            const tags: Array<{ environmentId: EnvironmentId; threadId: string; labelId: string }> =
              [];
            for (const environmentId of idsKey.split("\0") as EnvironmentId[]) {
              const target = { environmentId, input: {} };
              const list = Option.getOrNull(
                AsyncResult.value(get(serverEnvironment.projectLabelsLive(target))),
              );
              for (const label of list?.labels ?? []) {
                labels.push({
                  key: projectLabelKey(environmentId, label.id),
                  environmentId,
                  label,
                });
              }
              const confirmed = Option.getOrNull(
                AsyncResult.value(get(serverEnvironment.confirmedThreadProjectLabelsLive(target))),
              );
              for (const tag of confirmed?.labels ?? []) {
                tags.push({ environmentId, threadId: tag.threadId, labelId: tag.labelId });
              }
            }
            if (labels.length === 0) return EMPTY_DIRECTORY;
            const sorted = sortProjectLabels(labels);
            const byKey = new Map(sorted.map((entry) => [entry.key, entry] as const));
            const projectsByRepository = new Map<string, EnvironmentProjectLabel[]>();
            for (const entry of sorted) {
              for (const repositoryId of entry.label.repositoryIds) {
                const key = scopedRepositoryKey(entry.environmentId, repositoryId);
                const list = projectsByRepository.get(key);
                if (list) list.push(entry);
                else projectsByRepository.set(key, [entry]);
              }
            }
            const confirmedByThread = new Map<string, ProjectLabelKey[]>();
            for (const tag of tags) {
              const key = projectLabelKey(tag.environmentId, tag.labelId);
              if (!byKey.has(key)) continue;
              const threadKey = scopedThreadTagKey(tag.environmentId, tag.threadId);
              const list = confirmedByThread.get(threadKey);
              if (list) list.push(key);
              else confirmedByThread.set(threadKey, [key]);
            }
            for (const list of confirmedByThread.values()) {
              list.sort((left, right) =>
                byKey.get(left)!.label.name.localeCompare(byKey.get(right)!.label.name, undefined, {
                  sensitivity: "base",
                }),
              );
            }
            return { labels: sorted, byKey, projectsByRepository, confirmedByThread };
          }).pipe(Atom.withLabel("project-label-directory")),
    [idsKey],
  );
  return useAtomValue(atom);
}

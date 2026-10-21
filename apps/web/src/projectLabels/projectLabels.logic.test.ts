import {
  type EnvironmentId,
  ProjectId,
  ProjectLabelId,
  type ProjectLabelWithRepositories,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  priorFiling,
  projectLabelKey,
  repositoryFolderMove,
  scopedRepositoryKey,
  threadFolderState,
  undoFolderId,
  type EnvironmentProjectLabel,
} from "./projectLabels.logic";

const env = "env" as EnvironmentId;
const other = "other" as EnvironmentId;

function folder(
  environmentId: EnvironmentId,
  id: string,
  name: string,
  repositoryIds: string[] = [],
): EnvironmentProjectLabel {
  const label: ProjectLabelWithRepositories = {
    id: ProjectLabelId.make(id),
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    repositoryIds: repositoryIds.map((repositoryId) => ProjectId.make(repositoryId)),
    sourceLinks: [],
    threadCount: 0,
  };
  return { key: projectLabelKey(environmentId, id), environmentId, label };
}

const spawn = folder(env, "spawn", "Spawn Partners", ["server"]);
const bartr = folder(env, "bartr", "Bartr");
const remote = folder(other, "remote", "Remote");
const directory = {
  labels: [bartr, remote, spawn],
  byKey: new Map([bartr, remote, spawn].map((entry) => [entry.key, entry] as const)),
  folderByRepository: new Map([[scopedRepositoryKey(env, "server"), spawn]]),
};
const thread = (
  projectFolderId: string | null,
  projectFolderSource: "explicit" | "repository" | null = null,
) => ({
  environmentId: env,
  source: {
    projectFolderId: projectFolderId === null ? null : ProjectLabelId.make(projectFolderId),
    projectFolderSource,
  },
});

describe("threadFolderState", () => {
  it("offers only folders on the thread's own environment", () => {
    const state = threadFolderState(thread(null), directory);
    expect(state.current).toBeNull();
    expect(state.options.map((entry) => entry.label.name)).toEqual(["Bartr", "Spawn Partners"]);
  });

  it("lets only an explicit filing be removed; Work in its repository's folder cannot", () => {
    expect(threadFolderState(thread("spawn", "repository"), directory)).toMatchObject({
      current: spawn,
      source: "repository",
      viaRepository: true,
      removable: false,
    });
    expect(threadFolderState(thread("spawn", "explicit"), directory)).toMatchObject({
      viaRepository: false,
      removable: true,
    });
    // An older server sends no source: show the folder, offer no removal.
    expect(threadFolderState(thread("spawn"), directory).removable).toBe(false);
  });

  it("treats a folder this client does not know as unfiled", () => {
    const state = threadFolderState(thread("gone", "explicit"), directory);
    expect(state.current).toBeNull();
    expect(state.source).toBeNull();
  });
});

describe("undo of a move", () => {
  it("restores the exact prior filing", () => {
    const explicit = priorFiling(threadFolderState(thread("bartr", "explicit"), directory));
    expect(undoFolderId(explicit)).toBe("bartr");
    // Repository-derived Work goes back to having no explicit filing, so it keeps following its repo.
    const derived = priorFiling(threadFolderState(thread("spawn", "repository"), directory));
    expect(derived).toMatchObject({ id: "spawn", source: "repository" });
    expect(undoFolderId(derived)).toBeNull();
    expect(undoFolderId(priorFiling(threadFolderState(thread(null), directory)))).toBeNull();
  });
});
describe("repositoryFolderMove", () => {
  it("asks before taking a repository out of another folder", () => {
    expect(repositoryFolderMove(bartr.key, undefined)).toEqual({ from: null, needsConfirm: false });
    expect(repositoryFolderMove(spawn.key, spawn)).toEqual({ from: spawn, needsConfirm: false });
    expect(repositoryFolderMove(bartr.key, spawn)).toEqual({ from: spawn, needsConfirm: true });
  });
});

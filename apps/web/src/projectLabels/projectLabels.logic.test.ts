import {
  type EnvironmentId,
  ProjectId,
  ProjectLabelId,
  type ProjectLabelWithRepositories,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectLabelKey,
  repositoryFolderMove,
  scopedRepositoryKey,
  threadFolderState,
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
const thread = (projectId: string, projectFolderId: string | null) => ({
  environmentId: env,
  projectId: ProjectId.make(projectId),
  source: {
    projectFolderId: projectFolderId === null ? null : ProjectLabelId.make(projectFolderId),
  },
});

describe("threadFolderState", () => {
  it("offers only folders on the thread's own environment", () => {
    const state = threadFolderState(thread("scratch", null), false, directory);
    expect(state.current).toBeNull();
    expect(state.options.map((entry) => entry.label.name)).toEqual(["Bartr", "Spawn Partners"]);
  });

  it("marks Work in its repository's folder, so removing it is not offered", () => {
    expect(threadFolderState(thread("server", "spawn"), true, directory)).toMatchObject({
      current: spawn,
      viaRepository: true,
    });
    // Work filed elsewhere, and chats, can always come back out.
    expect(threadFolderState(thread("server", "bartr"), true, directory).viaRepository).toBe(false);
    expect(threadFolderState(thread("server", "spawn"), false, directory).viaRepository).toBe(
      false,
    );
  });

  it("treats a folder this client does not know as unfiled", () => {
    expect(threadFolderState(thread("scratch", "gone"), false, directory).current).toBeNull();
  });
});

describe("repositoryFolderMove", () => {
  it("asks before taking a repository out of another folder", () => {
    expect(repositoryFolderMove(bartr.key, undefined)).toEqual({ from: null, needsConfirm: false });
    expect(repositoryFolderMove(spawn.key, spawn)).toEqual({ from: spawn, needsConfirm: false });
    expect(repositoryFolderMove(bartr.key, spawn)).toEqual({ from: spawn, needsConfirm: true });
  });
});

import {
  type EnvironmentId,
  ProjectId,
  ProjectLabelId,
  type ProjectLabelWithRepositories,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isProjectLabelArchived,
  partitionArchivedProjectLabels,
  priorFiling,
  projectFolderChangeKind,
  projectLabelKey,
  repositoryFolderMove,
  scopedRepositoryKey,
  threadFolderState,
  undoFolderId,
  workThreadFolder,
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
    instructions: "",
    projectChatThreadId: null,
  };
  return { key: projectLabelKey(environmentId, id), environmentId, label };
}

const archive = (entry: EnvironmentProjectLabel): EnvironmentProjectLabel => ({
  ...entry,
  label: { ...entry.label, archivedAt: "2026-02-01T00:00:00.000Z" },
});

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

  it("never offers an archived folder, but still names the one a thread is in", () => {
    const archived = archive(spawn);
    const withArchived = {
      labels: [bartr, remote, archived],
      byKey: new Map([bartr, remote, archived].map((entry) => [entry.key, entry] as const)),
    };
    const state = threadFolderState(thread("spawn", "explicit"), withArchived);
    expect(state.current).toBe(archived);
    expect(state.options.map((entry) => entry.label.name)).toEqual(["Bartr"]);
  });

  it("keeps a project's own conversation where it is", () => {
    const home = {
      ...spawn,
      label: { ...spawn.label, projectChatThreadId: "project-chat:spawn" as never },
    };
    const withHome = {
      labels: [bartr, remote, home],
      byKey: new Map([bartr, remote, home].map((entry) => [entry.key, entry] as const)),
    };
    const chat = { ...thread("spawn", "explicit"), id: "project-chat:spawn" };
    expect(threadFolderState(chat, withHome)).toMatchObject({
      current: home,
      removable: false,
      options: [],
    });
    // Any other thread in the project still moves as usual.
    const sibling = { ...thread("spawn", "explicit"), id: "thread:sibling" };
    expect(threadFolderState(sibling, withHome).options).toHaveLength(2);
  });
});

describe("partitionArchivedProjectLabels", () => {
  it("splits active from archived folders, keeping each in order", () => {
    const archived = archive(bartr);
    const { active, archived: shelved } = partitionArchivedProjectLabels([archived, remote, spawn]);
    expect(active).toEqual([remote, spawn]);
    expect(shelved).toEqual([archived]);
    expect(isProjectLabelArchived(archived.label)).toBe(true);
    expect(isProjectLabelArchived(spawn.label)).toBe(false);
  });
});

describe("workThreadFolder", () => {
  const work = (
    projectId: string,
    projectFolderId: string | null,
    projectFolderSource: "explicit" | "repository" | null = null,
  ) => ({ ...thread(projectFolderId, projectFolderSource), projectId: ProjectId.make(projectId) });

  it("names the repository's project, even before the thread's own folder catches up", () => {
    expect(workThreadFolder(work("server", "spawn", "repository"), directory)).toBe(spawn);
    expect(workThreadFolder(work("server", null), directory)).toBe(spawn);
  });

  it("keeps an explicit filing over the repository's project", () => {
    expect(workThreadFolder(work("server", "bartr", "explicit"), directory)).toBe(bartr);
  });

  it("drops a repository project the repository has left, and names none without one", () => {
    expect(workThreadFolder(work("web", "spawn", "repository"), directory)).toBeNull();
    expect(workThreadFolder(work("web", null), directory)).toBeNull();
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

describe("projectFolderChangeKind", () => {
  const folder = ProjectLabelId.make("label:spawn");
  const run = { runId: "run:1", status: "completed" };
  const chat = (overrides: { surface?: string; role?: string; latestRun?: unknown } = {}) => ({
    source: {
      ...(overrides.surface === undefined ? {} : { surface: overrides.surface }),
      ...(overrides.role === undefined ? {} : { agent: { role: overrides.role } }),
    },
    latestRun: "latestRun" in overrides ? overrides.latestRun : null,
  });

  it("files a turnless chat in place", () => {
    expect(projectFolderChangeKind(chat({ surface: "chat" }), folder)).toBe("move");
  });

  it("forks a chat with turns, including one mid-turn", () => {
    expect(projectFolderChangeKind(chat({ surface: "chat", latestRun: run }), folder)).toBe("fork");
    expect(
      projectFolderChangeKind(
        chat({ surface: "chat", latestRun: { ...run, status: "running" } }),
        folder,
      ),
    ).toBe("fork");
    // Older shells omit the surface; the server treats them as chats too.
    expect(projectFolderChangeKind(chat({ latestRun: run }), folder)).toBe("fork");
  });

  it("always moves when taking a chat out of a project", () => {
    expect(projectFolderChangeKind(chat({ surface: "chat", latestRun: run }), null)).toBe("move");
  });

  it("moves Work, an agent's Work thread, and the builder, turns or not", () => {
    expect(projectFolderChangeKind(chat({ surface: "work", latestRun: run }), folder)).toBe("move");
    expect(projectFolderChangeKind(chat({ role: "work", latestRun: run }), folder)).toBe("move");
    expect(projectFolderChangeKind(chat({ surface: "builder", latestRun: run }), folder)).toBe(
      "move",
    );
  });
});

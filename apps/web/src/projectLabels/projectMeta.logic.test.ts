import {
  type EnvironmentId,
  ProjectId,
  ProjectLabelId,
  type ProjectLabelWithRepositories,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectLabelKey, type EnvironmentProjectLabel } from "./projectLabels.logic";
import {
  composerProjectFolderId,
  groupRepositoriesByProject,
  heroProjectSuffix,
  isRepositoryGroupOpen,
  projectDefaultRepository,
  threadProjectMeta,
  toggleCollapsedGroup,
  workDraftFolderId,
} from "./projectMeta.logic";

const env = "env" as EnvironmentId;
const other = "other" as EnvironmentId;

function folder(
  environmentId: EnvironmentId,
  id: string,
  name: string,
  repositoryIds: string[] = [],
  color?: string,
): EnvironmentProjectLabel {
  const label: ProjectLabelWithRepositories = {
    id: ProjectLabelId.make(id),
    name,
    ...(color ? { color } : {}),
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

const bartr = folder(env, "bartr", "Bartr", ["shared"]);
const spawn = folder(env, "spawn", "Spawn Partners", ["platform", "shared"], "violet");
const mind = folder(env, "mind", "SOSC 14100 Mind");
const remote = folder(other, "remote", "Remote", ["platform"]);
const projects = [bartr, remote, mind, spawn];
const byKey = new Map(projects.map((entry) => [entry.key, entry] as const));

const thread = (environmentId: EnvironmentId, folderId: string | null) => ({
  environmentId,
  source: { projectFolderId: folderId === null ? null : ProjectLabelId.make(folderId) },
});

describe("threadProjectMeta", () => {
  it("names the thread's project with its color", () => {
    expect(threadProjectMeta(thread(env, "spawn"), byKey)).toEqual({
      key: spawn.key,
      name: "Spawn Partners",
      color: "violet",
    });
  });

  it("stays single-line for unfiled chats and folders this client does not know", () => {
    expect(threadProjectMeta(thread(env, null), byKey)).toBeNull();
    expect(threadProjectMeta(thread(env, "deleted"), byKey)).toBeNull();
  });

  it("looks the folder up on the thread's own environment", () => {
    expect(threadProjectMeta(thread(other, "spawn"), byKey)).toBeNull();
    expect(threadProjectMeta(thread(other, "remote"), byKey)?.name).toBe("Remote");
  });
});

describe("composerProjectFolderId", () => {
  const picked = ProjectLabelId.make("mind");
  const filed = ProjectLabelId.make("spawn");

  it("shows a draft's choice until the thread carries it", () => {
    expect(composerProjectFolderId({ pendingFolderId: picked, threadFolderId: null })).toBe(picked);
    expect(composerProjectFolderId({ pendingFolderId: picked, threadFolderId: filed })).toBe(
      picked,
    );
  });

  it("falls back to where the thread is filed", () => {
    expect(composerProjectFolderId({ pendingFolderId: null, threadFolderId: filed })).toBe(filed);
    expect(composerProjectFolderId({ pendingFolderId: null, threadFolderId: null })).toBeNull();
  });
});

describe("heroProjectSuffix", () => {
  it("adds the project after the greeting only when one is set", () => {
    expect(heroProjectSuffix("SOSC 14100 Mind")).toBe(" · in SOSC 14100 Mind");
    expect(heroProjectSuffix(null)).toBeNull();
    expect(heroProjectSuffix("  ")).toBeNull();
  });
});

describe("groupRepositoriesByProject", () => {
  const repo = (name: string, environmentId: EnvironmentId = env) => ({
    name,
    refs: [{ environmentId, projectId: ProjectId.make(name) }],
  });
  const platform = repo("platform");
  const shared = repo("shared");
  const loose = repo("loose");
  const items = [loose, platform, shared];
  const group = (onlyProject?: (typeof spawn)["key"]) =>
    groupRepositoriesByProject({
      items,
      refsOf: (item) => item.refs,
      projects,
      ...(onlyProject ? { onlyProject } : {}),
    }).map((entry) => [entry.key, entry.items.map((item) => item.name)]);

  it("lists projects alphabetically with repositories in no project last", () => {
    expect(group()).toEqual([
      [bartr.key, ["shared"]],
      [spawn.key, ["platform", "shared"]],
      ["other", ["loose"]],
    ]);
  });

  it("shows a repository under every project holding it, matched per environment", () => {
    const remotePlatform = repo("platform", other);
    const groups = groupRepositoriesByProject({
      items: [remotePlatform, platform],
      refsOf: (item) => item.refs,
      projects,
    });
    expect(groups.map((entry) => entry.key)).toEqual([remote.key, spawn.key]);
    expect(groups[0]?.items).toEqual([remotePlatform]);
  });

  it("narrows to one project, even an empty one", () => {
    expect(group(spawn.key)).toEqual([[spawn.key, ["platform", "shared"]]]);
    expect(group(mind.key)).toEqual([[mind.key, []]]);
  });

  it("leads with the draft's project, the rest keeping their order", () => {
    const lead = groupRepositoriesByProject({
      items,
      refsOf: (item) => item.refs,
      projects,
      leadProject: spawn.key,
    }).map((entry) => entry.key);
    expect(lead).toEqual([spawn.key, bartr.key, "other"]);
  });
});

describe("projectDefaultRepository", () => {
  const repo = (name: string, activeAt: number, environmentId: EnvironmentId = env) => ({
    name,
    activeAt,
    refs: [{ environmentId, projectId: ProjectId.make(name) }],
  });
  const platform = repo("platform", 10);
  const shared = repo("shared", 30);
  const loose = repo("loose", 99);
  const items = [loose, platform, shared];
  const pick = (project: EnvironmentProjectLabel, current: string | null) =>
    projectDefaultRepository({
      items,
      refsOf: (item) => item.refs,
      project,
      isCurrent: (item) => item.name === current,
      lastActiveAt: (item) => item.activeAt,
    })?.name ?? null;

  it("keeps the current repository while the project holds it", () => {
    expect(pick(spawn, "platform")).toBe("platform");
  });

  it("otherwise picks the project's most recently active repository", () => {
    // "loose" is the most recent overall, but in no project.
    expect(pick(spawn, "loose")).toBe("shared");
    expect(pick(bartr, null)).toBe("shared");
  });

  it("takes the first on a tie, and only repositories on the project's machine", () => {
    const tied = projectDefaultRepository({
      items: [repo("platform", 5), repo("shared", 5)],
      refsOf: (item) => item.refs,
      project: spawn,
      isCurrent: () => false,
      lastActiveAt: (item) => item.activeAt,
    });
    expect(tied?.name).toBe("platform");
    const elsewhere = projectDefaultRepository({
      items: [repo("platform", 1, other)],
      refsOf: (item) => item.refs,
      project: spawn,
      isCurrent: () => false,
      lastActiveAt: (item) => item.activeAt,
    });
    expect(elsewhere).toBeNull();
  });

  it("is null for a project with no repositories", () => {
    expect(pick(mind, "loose")).toBeNull();
  });
});

describe("workDraftFolderId", () => {
  const folderByRepository = new Map([
    [`${env}:platform`, spawn],
    [`${other}:platform`, remote],
  ]);
  const repository = (projectId: string, environmentId: EnvironmentId = env) => ({
    environmentId,
    projectId: ProjectId.make(projectId),
  });

  it("records nothing when Work follows its repository's own project", () => {
    expect(
      workDraftFolderId({ repository: repository("platform"), project: spawn, folderByRepository }),
    ).toBeNull();
    expect(
      workDraftFolderId({ repository: repository("loose"), project: null, folderByRepository }),
    ).toBeNull();
  });

  it("files Work in a project that is not its repository's", () => {
    expect(
      workDraftFolderId({ repository: repository("loose"), project: mind, folderByRepository }),
    ).toBe(mind.label.id);
    expect(
      workDraftFolderId({ repository: repository("platform"), project: bartr, folderByRepository }),
    ).toBe(bartr.label.id);
  });

  it("drops a project on another machine than the repository", () => {
    expect(
      workDraftFolderId({
        repository: repository("loose", other),
        project: mind,
        folderByRepository,
      }),
    ).toBeNull();
  });
});

describe("repository picker groups", () => {
  const open = (collapsedKeys: string[], searching = false, hasMatches = true) =>
    isRepositoryGroupOpen({ groupKey: "env:spawn", collapsedKeys, searching, hasMatches });

  it("starts open and remembers a collapse", () => {
    expect(open([])).toBe(true);
    expect(open(["env:spawn"])).toBe(false);
    expect(open(["env:bartr"])).toBe(true);
  });

  it("opens a collapsed group while a search matches inside it", () => {
    expect(open(["env:spawn"], true, true)).toBe(true);
    expect(open([], true, false)).toBe(false);
  });

  it("toggles one group without touching the others", () => {
    expect(toggleCollapsedGroup(["env:bartr"], "env:spawn")).toEqual(["env:bartr", "env:spawn"]);
    expect(toggleCollapsedGroup(["env:bartr", "env:spawn"], "env:spawn")).toEqual(["env:bartr"]);
  });
});

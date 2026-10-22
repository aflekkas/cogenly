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
  heroProjectKey,
  heroProjectSuffix,
  isRepositoryGroupOpen,
  soleRepositoryOf,
  threadProjectMeta,
  toggleCollapsedGroup,
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

  it("selects a project's repository on its own only when it is the only one", () => {
    const narrowed = (key: (typeof spawn)["key"]) =>
      groupRepositoriesByProject({
        items,
        refsOf: (item) => item.refs,
        projects,
        onlyProject: key,
      });
    expect(soleRepositoryOf(narrowed(bartr.key))).toBe(shared);
    expect(soleRepositoryOf(narrowed(spawn.key))).toBeNull();
    expect(soleRepositoryOf(narrowed(mind.key))).toBeNull();
  });
});

describe("heroProjectKey", () => {
  const sharedRepo = [{ environmentId: env, projectId: ProjectId.make("shared") }];

  it("names the project the repository was picked under", () => {
    expect(heroProjectKey({ chosen: spawn.key, repository: sharedRepo, projects })).toBe(spawn.key);
  });

  it("falls back to the first project holding the repository", () => {
    expect(heroProjectKey({ chosen: null, repository: sharedRepo, projects })).toBe(bartr.key);
    // A choice that no longer holds the repository does not stick.
    expect(heroProjectKey({ chosen: mind.key, repository: sharedRepo, projects })).toBe(bartr.key);
  });

  it("is null for a repository in no project", () => {
    expect(
      heroProjectKey({
        chosen: null,
        repository: [{ environmentId: env, projectId: ProjectId.make("loose") }],
        projects,
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

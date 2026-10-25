import {
  type EnvironmentId,
  ProjectId,
  ProjectLabelId,
  type ProjectLabelWithRepositories,
} from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectLabelKey, type EnvironmentProjectLabel } from "./projectLabels.logic";
import {
  composerProjectFolderId,
  draftWorkProject,
  groupRepositoriesByProject,
  heroProjectSuffix,
  isPickableRepository,
  projectDefaultRepository,
  projectHoldsRepository,
  projectSwitchRepository,
  threadProjectMeta,
  toggleCollapsedGroup,
  workDraftFolderId,
  workHeroBreadcrumb,
  workHeroLine,
  workThreadDisplayProject,
} from "./projectMeta.logic";

const env = "env" as EnvironmentId;
const other = "other" as EnvironmentId;

describe("isPickableRepository", () => {
  const scratch = "/Users/me/.cogenly/scratch";
  const pickable = (workspaceRoot: string, scratchRoot: string | null = scratch) =>
    isPickableRepository({ workspaceRoot }, scratchRoot);

  it("lists a normal repository", () => {
    expect(pickable("/Users/me/Documents/Projects/cogenly")).toBe(true);
    expect(pickable("/Users/me/Documents/Projects/cogenly", null)).toBe(true);
    // A folder merely named scratch is still a repository.
    expect(pickable("/Users/me/code/scratch")).toBe(true);
  });

  it("never lists the Scratch project", () => {
    expect(pickable(scratch)).toBe(false);
    expect(pickable(`${scratch}/`)).toBe(false);
    expect(isPickableRepository({ workspaceRoot: "/elsewhere", isScratch: true }, null)).toBe(
      false,
    );
  });

  it("never lists Scratch thread folders, including a T3 Code import's", () => {
    expect(pickable(`${scratch}/2026-10-03-yo-can-we-build-a-41764429`)).toBe(false);
    // T3 Code's Scratch, imported under the machine's name ("MacBook").
    expect(pickable("/Users/me/.t3/scratch")).toBe(false);
    expect(pickable("/Users/me/.t3/scratch/2026-10-03-yo-can-we-build-a-41764429", null)).toBe(
      false,
    );
    expect(pickable("/srv/data/scratch/thread-folder", "/srv/data/scratch")).toBe(false);
  });

  it("never lists the home folder the data dir sits in, whatever it is named", () => {
    expect(pickable("/Users/me")).toBe(false);
    expect(pickable("/Users")).toBe(false);
    expect(pickable("/Users/other")).toBe(true);
    // A data dir that is not hidden says nothing about the home folder.
    expect(pickable("/srv", "/srv/cogenly-data/scratch")).toBe(true);
  });

  it("compares Windows paths regardless of case and separator", () => {
    expect(pickable("c:/users/me/.cogenly/scratch/x", "C:\\Users\\me\\.cogenly\\scratch")).toBe(
      false,
    );
    expect(pickable("C:\\Users\\me", "C:\\Users\\me\\.cogenly\\scratch")).toBe(false);
    expect(pickable("C:\\Users\\me\\repo", "C:\\Users\\me\\.cogenly\\scratch")).toBe(true);
  });
});

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

  it("picks among repositories in no project for No project", () => {
    const none = (current: string | null) =>
      projectDefaultRepository({
        items: [...items, repo("scratchpad", 50)],
        refsOf: (item) => item.refs,
        project: null,
        projects,
        isCurrent: (item) => item.name === current,
        lastActiveAt: (item) => item.activeAt,
      })?.name ?? null;
    // "shared" is current, but in a project: the latest loose one wins.
    expect(none("shared")).toBe("loose");
    expect(none("scratchpad")).toBe("scratchpad");
  });
});

describe("workDraftFolderId", () => {
  const repository = (projectId: string, environmentId: EnvironmentId = env) => ({
    environmentId,
    projectId: ProjectId.make(projectId),
  });
  const file = (
    repositoryRef: ReturnType<typeof repository>,
    project: EnvironmentProjectLabel | null,
  ) => workDraftFolderId({ repository: repositoryRef, project, byKey });

  it("keeps the draft's project when a repository in it is picked", () => {
    // The repository's own project stays filed, so the pick never drops it.
    expect(file(repository("platform"), spawn)).toBe(spawn.label.id);
    // A repository just cloned here, which no project lists yet.
    expect(file(repository("just-cloned"), spawn)).toBe(spawn.label.id);
  });

  it("records nothing without a project", () => {
    expect(file(repository("loose"), null)).toBeNull();
  });

  it("keeps a synced project on the repository's machine, and drops one that machine lacks", () => {
    const synced = folder(other, "spawn", "Spawn Partners");
    const withSynced = new Map([...byKey, [synced.key, synced] as const]);
    expect(
      workDraftFolderId({
        repository: repository("platform", other),
        project: spawn,
        byKey: withSynced,
      }),
    ).toBe(spawn.label.id);
    expect(file(repository("loose", other), mind)).toBeNull();
  });
});

const ref = (projectId: string, environmentId: EnvironmentId = env) => ({
  environmentId,
  projectId: ProjectId.make(projectId),
});
const folderByRepository = new Map([
  [`${env}:platform`, spawn],
  [`${env}:shared`, spawn],
  [`${other}:platform`, remote],
]);

describe("projectHoldsRepository", () => {
  it("reads the project as the repository's machine has it", () => {
    expect(projectHoldsRepository(spawn, ref("platform"))).toBe(true);
    expect(projectHoldsRepository(spawn, ref("cogenly"))).toBe(false);
    // The same id on another machine is another checkout.
    expect(projectHoldsRepository(spawn, ref("platform", other))).toBe(false);
    const synced: EnvironmentProjectLabel = {
      ...spawn,
      copies: [
        { environmentId: env, label: spawn.label },
        { environmentId: other, label: { ...spawn.label, repositoryIds: [ProjectId.make("vps")] } },
      ],
    };
    expect(projectHoldsRepository(synced, ref("vps", other))).toBe(true);
    expect(projectHoldsRepository(synced, ref("platform", other))).toBe(false);
  });
});

describe("projectSwitchRepository", () => {
  const items = ["platform", "shared", "cogenly"].map((name) => ({ name, refs: [ref(name)] }));
  const pick = (project: EnvironmentProjectLabel, current: string | null, list = items) => {
    const next = projectSwitchRepository({
      project,
      current: current === null ? null : ref(current),
      items: list,
      refsOf: (item) => item.refs,
    });
    return next.kind === "select" ? `select:${next.item.name}` : next.kind;
  };
  const solo = folder(env, "solo", "Solo", ["platform"]);

  it("keeps the repository while the project holds it", () => {
    expect(pick(spawn, "shared")).toBe("keep");
  });

  it("never keeps a repository from outside the project", () => {
    // The bug: Spawn Partners picked over cogenly, which is in no project.
    expect(pick(spawn, "cogenly")).not.toBe("keep");
    expect(pick(solo, "cogenly")).toBe("select:platform");
  });

  it("selects the project's only repository", () => {
    expect(pick(solo, null)).toBe("select:platform");
  });

  it("leaves the repository to be chosen when the project has several", () => {
    expect(pick(spawn, "cogenly")).toBe("choose");
    // One linked repository not on this machine yet is still a choice to make here.
    const elsewhere = folder(env, "elsewhere", "Elsewhere", ["not-here"]);
    expect(pick(elsewhere, "cogenly")).toBe("choose");
  });

  it("runs in the project folder when the project has no repository", () => {
    expect(pick(mind, "cogenly")).toBe("project-folder");
    expect(pick(mind, null)).toBe("project-folder");
  });
});

describe("draftWorkProject", () => {
  const draft = (
    pending: EnvironmentProjectLabel | null,
    repository: string | null,
    pendingRepositoryId?: string | null,
  ) =>
    draftWorkProject({
      pending,
      pendingRepositoryId:
        pendingRepositoryId == null ? pendingRepositoryId : ProjectId.make(pendingRepositoryId),
      repository: repository === null ? null : ref(repository),
      folderByRepository,
    });

  it("follows the repository's own project without a pick, or none", () => {
    expect(draft(null, "platform")).toEqual({ project: spawn, stale: false });
    expect(draft(null, "cogenly")).toEqual({ project: null, stale: false });
  });

  it("keeps a pick that holds the repository", () => {
    expect(draft(spawn, "shared")).toEqual({ project: spawn, stale: false });
  });

  it("marks a pick that does not hold the repository stale", () => {
    expect(draft(spawn, "cogenly")).toEqual({ project: spawn, stale: true });
  });

  it("trusts a pick filed with this repository while its link lands", () => {
    expect(draft(spawn, "just-linked", "just-linked").stale).toBe(false);
    // Filed with another repository, it does not carry over.
    expect(draft(spawn, "cogenly", "platform").stale).toBe(true);
  });

  it("lets any project hold Work without a repository", () => {
    expect(draft(mind, null)).toEqual({ project: mind, stale: false });
  });
});

describe("workThreadDisplayProject", () => {
  const shown = (filed: EnvironmentProjectLabel | null, repository: string | null) =>
    workThreadDisplayProject({
      filed,
      repository: repository === null ? null : ref(repository),
      folderByRepository,
    })?.label.name ?? null;

  it("names the filing while it holds the repository", () => {
    expect(shown(spawn, "platform")).toBe("Spawn Partners");
  });

  it("names the repository's own project, or none, instead of a filing without it", () => {
    expect(shown(mind, "platform")).toBe("Spawn Partners");
    expect(shown(spawn, "cogenly")).toBeNull();
  });

  it("names the filing for Work in its project's folder", () => {
    expect(shown(mind, null)).toBe("SOSC 14100 Mind");
  });
});

describe("toggleCollapsedGroup", () => {
  it("toggles one group without touching the others", () => {
    expect(toggleCollapsedGroup(["env:bartr"], "env:spawn")).toEqual(["env:bartr", "env:spawn"]);
    expect(toggleCollapsedGroup(["env:bartr", "env:spawn"], "env:spawn")).toEqual(["env:bartr"]);
  });
});

describe("workHeroLine", () => {
  const line = (input: Partial<Parameters<typeof workHeroLine>[0]>) =>
    workHeroLine({
      isChat: false,
      hasProject: false,
      hasRepository: true,
      canStartWithoutRepository: true,
      ...input,
    });

  it("offers the no-repository row beside a repository, in a project or not", () => {
    expect(line({ hasProject: true })).toEqual({
      projectFolderRow: "offered",
      projectFolderRowLabel: "No repository (project folder)",
    });
    expect(line({})).toEqual({
      projectFolderRow: "offered",
      projectFolderRowLabel: "No repository",
    });
  });

  it("does not offer it where Work cannot run without a repository", () => {
    expect(line({ hasProject: true, canStartWithoutRepository: false }).projectFolderRow).toBe(
      "hidden",
    );
  });

  it("checks it for Work without a repository", () => {
    expect(line({ hasProject: true, hasRepository: false }).projectFolderRow).toBe("selected");
    expect(line({ hasRepository: false }).projectFolderRow).toBe("selected");
  });

  it("leaves chats without one", () => {
    expect(line({ isChat: true, hasProject: true }).projectFolderRow).toBe("hidden");
  });

  it("offers it unchecked while the project's repository is still to be chosen", () => {
    expect(
      line({ hasProject: true, hasRepository: false, repositoryUnchosen: true }).projectFolderRow,
    ).toBe("offered");
  });
});

describe("workHeroBreadcrumb", () => {
  it("names a project and its repository", () => {
    expect(
      workHeroBreadcrumb({
        projectName: "Spawn Partners",
        repositoryName: "aflekkas/cogenly",
        hasRepository: true,
      }),
    ).toEqual({
      project: { text: "Spawn Partners", placeholder: false },
      repository: { text: "aflekkas/cogenly", placeholder: false },
      label: "What should we build in Spawn Partners / aflekkas/cogenly?",
    });
  });

  it("reads No project for a repository in none", () => {
    const crumb = workHeroBreadcrumb({
      projectName: null,
      repositoryName: "loose",
      hasRepository: true,
    });
    expect(crumb.project).toEqual({ text: "No project", placeholder: true });
    expect(crumb.label).toBe("What should we build in No project / loose?");
  });

  it("names Work without a repository by where it runs", () => {
    expect(
      workHeroBreadcrumb({
        projectName: "Mind",
        repositoryName: "No project",
        hasRepository: false,
      }).label,
    ).toBe("What should we build in Mind / project folder?");
    expect(
      workHeroBreadcrumb({ projectName: "  ", repositoryName: null, hasRepository: false }).label,
    ).toBe("What should we build in No project / no repository?");
  });

  it("asks for a repository while none of the project's is picked", () => {
    const crumb = workHeroBreadcrumb({
      projectName: "Spawn Partners",
      repositoryName: null,
      hasRepository: false,
      repositoryUnchosen: true,
    });
    expect(crumb.repository).toEqual({ text: "Choose a repository", placeholder: true });
  });

  it("holds a placeholder while the repository is unknown", () => {
    expect(
      workHeroBreadcrumb({ projectName: null, repositoryName: null, hasRepository: true })
        .repository,
    ).toEqual({ text: "a repository", placeholder: true });
  });
});

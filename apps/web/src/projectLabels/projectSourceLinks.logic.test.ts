import {
  EnvironmentId,
  ProjectId,
  ProjectLabelId,
  type ProjectLabelOwnerRepository,
  type ProjectLabelWithRepositories,
  type ProjectSourceLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectLabelKey, type EnvironmentProjectLabel } from "./projectLabels.logic";
import { groupRepositoriesByProject } from "./projectMeta.logic";
import {
  hasProjectSourceLink,
  mergeRemoteRepositorySections,
  ownerSearchErrorMessage,
  ownerSearchProjects,
  parseProjectSourceLink,
  projectExtraSourceLinks,
  projectGitHubOrg,
  remoteRepositoryRows,
  sortProjectSourceLinks,
  type OwnerSearchState,
} from "./projectSourceLinks.logic";

describe("projectGitHubOrg / projectExtraSourceLinks", () => {
  const org: ProjectSourceLink = { kind: "github-owner", owner: "Spawn-Partners" };
  const covered: ProjectSourceLink = {
    kind: "github-repo",
    owner: "spawn-partners",
    repo: "platform",
  };
  const outside: ProjectSourceLink = { kind: "github-repo", owner: "acme", repo: "tools" };
  const second: ProjectSourceLink = { kind: "github-owner", owner: "acme-labs" };

  it("takes the first linked owner as the project's org", () => {
    expect(projectGitHubOrg([covered, org, second])).toBe("Spawn-Partners");
    expect(projectGitHubOrg([covered])).toBeNull();
  });

  it("lists further owners and only repositories no owner covers", () => {
    expect(projectExtraSourceLinks([org, covered, outside, second])).toEqual([second, outside]);
    expect(projectExtraSourceLinks([covered])).toEqual([covered]);
  });
});

const env = EnvironmentId.make("env");

function folder(
  id: string,
  name: string,
  repositoryIds: string[] = [],
  sourceLinks: ProjectSourceLink[] = [],
): EnvironmentProjectLabel {
  const label: ProjectLabelWithRepositories = {
    id: ProjectLabelId.make(id),
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    repositoryIds: repositoryIds.map((repositoryId) => ProjectId.make(repositoryId)),
    sourceLinks,
    threadCount: 0,
    instructions: "",
    projectChatThreadId: null,
  };
  return { key: projectLabelKey(env, id), environmentId: env, label };
}

function repo(nameWithOwner: string, alreadyLocal = false): ProjectLabelOwnerRepository {
  const [owner = "", name = ""] = nameWithOwner.split("/");
  return {
    owner,
    name,
    nameWithOwner,
    description: null,
    private: false,
    defaultBranch: "main",
    pushedAt: null,
    alreadyLocal,
  };
}

describe("parseProjectSourceLink", () => {
  it("reads owners, owner/repo and GitHub URLs", () => {
    expect(parseProjectSourceLink(" spawn-partners ")).toEqual({
      kind: "github-owner",
      owner: "spawn-partners",
    });
    expect(parseProjectSourceLink("spawn-partners/server")).toEqual({
      kind: "github-repo",
      owner: "spawn-partners",
      repo: "server",
    });
    expect(parseProjectSourceLink("https://github.com/spawn-partners/server.git")).toEqual({
      kind: "github-repo",
      owner: "spawn-partners",
      repo: "server",
    });
    expect(parseProjectSourceLink("git@github.com:spawn-partners/server.git")).toEqual({
      kind: "github-repo",
      owner: "spawn-partners",
      repo: "server",
    });
    expect(parseProjectSourceLink("https://github.com/spawn-partners/")).toEqual({
      kind: "github-owner",
      owner: "spawn-partners",
    });
    expect(parseProjectSourceLink("github.com/a/b/tree/main")).toEqual({
      kind: "github-repo",
      owner: "a",
      repo: "b",
    });
  });

  it("rejects what GitHub would not accept", () => {
    expect(parseProjectSourceLink("")).toBeNull();
    expect(parseProjectSourceLink("-bad")).toBeNull();
    expect(parseProjectSourceLink("bad-")).toBeNull();
    expect(parseProjectSourceLink("owner/re po")).toBeNull();
    expect(parseProjectSourceLink("owner/..")).toBeNull();
  });
});

describe("source links", () => {
  it("treats names case-insensitively and lists owners first", () => {
    const links: ProjectSourceLink[] = [
      { kind: "github-repo", owner: "a", repo: "z" },
      { kind: "github-owner", owner: "Spawn" },
      { kind: "github-owner", owner: "acme" },
    ];
    expect(hasProjectSourceLink(links, { kind: "github-owner", owner: "spawn" })).toBe(true);
    expect(hasProjectSourceLink(links, { kind: "github-repo", owner: "spawn", repo: "x" })).toBe(
      false,
    );
    expect(sortProjectSourceLinks(links).map((link) => link.owner)).toEqual(["acme", "Spawn", "a"]);
  });

  it("searches every project while the picker is open, linked to an owner or not", () => {
    const owner = folder("p1", "Spawn", [], [{ kind: "github-owner", owner: "spawn" }]);
    const unlinked = folder("p2", "Solo", [], [{ kind: "github-repo", owner: "a", repo: "b" }]);
    expect(ownerSearchProjects([owner, unlinked], false)).toEqual([]);
    expect(ownerSearchProjects([owner, unlinked], true)).toEqual([owner, unlinked]);
  });

  it("names the owner in a not-connected error, or the account when none is linked", () => {
    expect(ownerSearchErrorMessage("github_not_connected", ["spawn-partners"])).toBe(
      "Connect GitHub to search spawn-partners",
    );
    expect(ownerSearchErrorMessage("github_not_connected", [])).toBe(
      "Connect GitHub to search your repositories",
    );
  });
});

describe("remoteRepositoryRows", () => {
  it("drops repositories already local and duplicates across owners", () => {
    expect(
      remoteRepositoryRows([repo("a/one", true), repo("a/two"), repo("A/Two"), repo("b/three")]),
    ).toEqual([repo("a/two"), repo("b/three")]);
  });
});

describe("mergeRemoteRepositorySections", () => {
  const alpha = folder("alpha", "Alpha", ["r1"], [{ kind: "github-owner", owner: "alpha" }]);
  const beta = folder("beta", "Beta", ["r2"], [{ kind: "github-owner", owner: "beta" }]);
  const gamma = folder("gamma", "Gamma", ["r3"]);
  const projects = [alpha, beta, gamma];
  const items = [
    { id: "r1", label: "server" },
    { id: "r3", label: "server-tools" },
    { id: "r9", label: "loose-server" },
  ];
  const groups = groupRepositoriesByProject({
    items,
    refsOf: (item) => [{ environmentId: env, projectId: ProjectId.make(item.id) }],
    projects,
  });

  it("puts GitHub results after their project, with a header for a project without local matches", () => {
    const remote = new Map<string, OwnerSearchState>([
      [alpha.key, { status: "done", repositories: [repo("alpha/server-api")] }],
      [beta.key, { status: "loading" }],
    ]);
    const sections = mergeRemoteRepositorySections({
      groups,
      projects,
      remoteOf: (key) => remote.get(key),
    });
    expect(
      sections.map((section) =>
        section.kind === "local"
          ? `local:${section.group.key}:${section.group.items.length}`
          : `remote:${section.project.label.name}:${section.state.status}:${section.repositories.length}`,
      ),
    ).toEqual([
      `local:${alpha.key}:1`,
      "remote:Alpha:done:1",
      `local:${beta.key}:0`,
      "remote:Beta:loading:0",
      `local:${gamma.key}:1`,
      "local:other:1",
    ]);
  });

  it("adds nothing for a search that found only local or no repositories", () => {
    const remote = new Map<string, OwnerSearchState>([
      [alpha.key, { status: "done", repositories: [repo("alpha/server", true)] }],
      [beta.key, { status: "done", repositories: [] }],
    ]);
    const sections = mergeRemoteRepositorySections({
      groups,
      projects,
      remoteOf: (key) => remote.get(key),
    });
    expect(sections.every((section) => section.kind === "local")).toBe(true);
    expect(sections).toHaveLength(groups.length);
  });

  it("shows a failed search as its own section", () => {
    const remote = new Map<string, OwnerSearchState>([
      [beta.key, { status: "error", message: "Connect GitHub to search beta" }],
    ]);
    const sections = mergeRemoteRepositorySections({
      groups,
      projects,
      remoteOf: (key) => remote.get(key),
    });
    expect(sections[1]?.kind).toBe("local");
    expect(sections[2]).toMatchObject({ kind: "remote", state: { status: "error" } });
  });
});

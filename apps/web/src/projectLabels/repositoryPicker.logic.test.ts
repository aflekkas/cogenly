import type { ProjectLabelOwnerRepository, RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeCloneFailure,
  gitHubRepositoryKeys,
  gitHubRepositoryOf,
  groupRepositoriesByMachine,
  REMOTE_ROWS_PREVIEW_LIMIT,
  remoteRowsOutsideProject,
  remoteSectionRows,
} from "./repositoryPicker.logic";

function identity(canonicalKey: string, origin?: string): RepositoryIdentity {
  return {
    canonicalKey,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${canonicalKey}` },
    ...(origin ? { origin: { canonicalKey: origin } } : {}),
  };
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

describe("gitHubRepositoryKeys", () => {
  it("names the canonical remote and a fork's own remote", () => {
    expect(
      gitHubRepositoryKeys(identity("github.com/upstream/app", "github.com/spawn/app")),
    ).toEqual(["upstream/app", "spawn/app"]);
  });

  it("ignores other hosts and checkouts without a remote", () => {
    expect(gitHubRepositoryKeys(identity("gitlab.com/spawn/app"))).toEqual([]);
    expect(gitHubRepositoryKeys(null)).toEqual([]);
  });
});

describe("gitHubRepositoryOf", () => {
  it("prefers the checkout's own remote", () => {
    expect(gitHubRepositoryOf(identity("github.com/upstream/app", "github.com/spawn/app"))).toBe(
      "spawn/app",
    );
    expect(gitHubRepositoryOf(identity("github.com/spawn/app"))).toBe("spawn/app");
    expect(gitHubRepositoryOf(identity("gitlab.com/spawn/app"))).toBe(null);
  });
});

describe("remoteRowsOutsideProject", () => {
  it("shows each repository once: a local checkout wins, case-insensitively", () => {
    const rows = remoteRowsOutsideProject(
      [
        repo("Spawn/Smile-Express"),
        repo("spawn/finance"),
        repo("spawn/design-system", true),
        repo("other/finance"),
        repo("spawn/finance"),
      ],
      [identity("github.com/spawn/smile-express"), undefined],
    );
    expect(rows.map((row) => row.nameWithOwner)).toEqual(["spawn/finance", "other/finance"]);
  });

  it("matches a fork's own remote", () => {
    const rows = remoteRowsOutsideProject(
      [repo("spawn/app")],
      [identity("github.com/upstream/app", "github.com/spawn/app")],
    );
    expect(rows).toEqual([]);
  });
});

describe("any GitHub remote", () => {
  // smile-express: origin on GitHub Enterprise, the GitHub repository on a second remote.
  const mirrored: RepositoryIdentity = {
    ...identity("smiledoctors.ghe.com/marketing/smileexpressapp"),
    remoteKeys: [
      "github.com/spawn-partners/smile-express",
      "smiledoctors.ghe.com/marketing/smileexpressapp",
    ],
  };

  it("counts a second remote on GitHub as the checkout's GitHub repository", () => {
    expect(gitHubRepositoryKeys(mirrored)).toEqual(["spawn-partners/smile-express"]);
    expect(gitHubRepositoryOf(mirrored)).toBe("spawn-partners/smile-express");
    expect(remoteRowsOutsideProject([repo("Spawn-Partners/smile-express")], [mirrored])).toEqual(
      [],
    );
  });
});

describe("remoteSectionRows", () => {
  const many = Array.from({ length: REMOTE_ROWS_PREVIEW_LIMIT + 3 }, (_, index) =>
    repo(`spawn/repo-${index}`),
  );

  it("names a result by owner when a local checkout answers to a same-named repository", () => {
    // bartr-platform is bartr-app/platform; another owner's "platform" must not read as it.
    const { rows } = remoteSectionRows({
      repositories: [repo("mediamaxxing/platform"), repo("aflekkas/pane-browser")],
      local: [identity("github.com/bartr-app/platform")],
      searching: false,
      expanded: false,
    });
    expect(rows.map((row) => row.label)).toEqual(["mediamaxxing/platform", "pane-browser"]);
  });

  it("names results by owner when two share a name", () => {
    const { rows } = remoteSectionRows({
      repositories: [repo("spawn/finance"), repo("other/finance")],
      local: [],
      searching: false,
      expanded: false,
    });
    expect(rows.map((row) => row.label)).toEqual(["spawn/finance", "other/finance"]);
  });

  it("previews a few results until expanded or searched", () => {
    const preview = remoteSectionRows({
      repositories: many,
      local: [],
      searching: false,
      expanded: false,
    });
    expect(preview.rows).toHaveLength(REMOTE_ROWS_PREVIEW_LIMIT);
    expect(preview.hidden).toBe(3);
    for (const mode of [
      { searching: true, expanded: false },
      { searching: false, expanded: true },
    ]) {
      const all = remoteSectionRows({ repositories: many, local: [], ...mode });
      expect(all.rows).toHaveLength(many.length);
      expect(all.hidden).toBe(0);
    }
  });
});

describe("groupRepositoriesByMachine", () => {
  it("puts each repository under its own machine, the primary first", () => {
    const sections = groupRepositoriesByMachine(
      [
        { name: "spawn-platform", environmentId: "vps" },
        { name: "smile-express", environmentId: "mac" },
        { name: "finance", environmentId: "vps" },
      ],
      (item) => item.environmentId,
      "mac",
    );
    expect(
      sections.map((section) => [section.environmentId, section.items.map((item) => item.name)]),
    ).toEqual([
      ["mac", ["smile-express"]],
      ["vps", ["spawn-platform", "finance"]],
    ]);
  });
});

describe("describeCloneFailure", () => {
  it("strips the server's prefix and leads with advice", () => {
    const failure = describeCloneFailure(
      "Source control repository operation cloneRepository failed for github: remote: Repository not found.\nfatal: repository 'https://github.com/spawn/x.git/' not found",
      "spawn/x",
    );
    expect(failure.summary).toBe(
      "GitHub couldn't find spawn/x, or this machine's GitHub account can't access it.",
    );
    expect(failure.detail).toMatch(/^remote: Repository not found\./);
  });

  it("tells an occupied destination apart from access problems", () => {
    expect(
      describeCloneFailure("Destination path already exists and is not empty.", "smile-express")
        .summary,
    ).toMatch(/^A folder named smile-express is already/);
    expect(
      describeCloneFailure(
        "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
        "spawn/x",
      ).summary,
    ).toBe("This machine isn't signed in to GitHub with access to spawn/x.");
  });

  it("falls back to the message's first line, without repeating it as detail", () => {
    expect(describeCloneFailure("Something odd happened", "spawn/x")).toEqual({
      summary: "Something odd happened",
      detail: null,
    });
    expect(describeCloneFailure("", "spawn/x")).toEqual({
      summary: "The clone failed.",
      detail: null,
    });
  });
});

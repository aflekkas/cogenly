import type { ProjectLabelOwnerRepository, RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeCloneFailure,
  gitHubRepositoryKeys,
  gitHubRepositoryOf,
  remoteRowsOutsideProject,
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

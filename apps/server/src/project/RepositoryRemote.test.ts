import { describe, expect, it } from "vite-plus/test";

import { normalizeRepositoryRemote, repositoryDirectoryName } from "./RepositoryRemote.ts";

describe("normalizeRepositoryRemote", () => {
  it("unifies ssh and https spellings of the same repository", () => {
    expect(normalizeRepositoryRemote("git@github.com:Spawn-Partners/Platform.git")).toBe(
      "github.com/spawn-partners/platform",
    );
    expect(normalizeRepositoryRemote("https://github.com/Spawn-Partners/Platform.git")).toBe(
      "github.com/spawn-partners/platform",
    );
    expect(normalizeRepositoryRemote("ssh://git@github.com:22/Spawn-Partners/Platform")).toBe(
      "github.com/spawn-partners/platform",
    );
  });

  it("lowercases the host, drops credentials, ports and the .git suffix", () => {
    expect(normalizeRepositoryRemote("https://user:secret@GitHub.COM:8443/Owner/Repo.git/")).toBe(
      "github.com/owner/repo",
    );
  });

  it("keeps subgroups and non-GitHub hosts", () => {
    expect(normalizeRepositoryRemote("git@gitlab.example.com:group/sub/project.git")).toBe(
      "gitlab.example.com/group/sub/project",
    );
  });

  it("marks local-only repositories and non-remotes as null", () => {
    expect(normalizeRepositoryRemote(null)).toBeNull();
    expect(normalizeRepositoryRemote(undefined)).toBeNull();
    expect(normalizeRepositoryRemote("")).toBeNull();
    expect(normalizeRepositoryRemote("/Users/me/repos/platform")).toBeNull();
    expect(normalizeRepositoryRemote("./platform")).toBeNull();
    expect(normalizeRepositoryRemote("file:///Users/me/repos/platform")).toBeNull();
    expect(normalizeRepositoryRemote("platform")).toBeNull();
  });
});

describe("repositoryDirectoryName", () => {
  it("takes the last segment of the workspace root", () => {
    expect(repositoryDirectoryName("/projects/Spawn Partners/platform")).toBe("platform");
    expect(repositoryDirectoryName("/projects/Spawn Partners/platform/")).toBe("platform");
    expect(repositoryDirectoryName("")).toBeNull();
  });
});

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectLabelCloneRepositoryInput,
  ProjectLabelCreateInput,
  ProjectLabelError,
  ProjectLabelOwnerRepositorySearchInput,
  ProjectLabelSourceLinkInput,
  ProjectLabelUpdateInput,
  ProjectLabelWithRepositories,
  ProjectSourceLink,
  projectHomeOwner,
  repositoryDirectoryNameFor,
} from "./projectLabel.ts";

describe("project colors", () => {
  const decodeCreate = Schema.decodeUnknownSync(ProjectLabelCreateInput);
  const decodeUpdate = Schema.decodeUnknownSync(ProjectLabelUpdateInput);

  it("takes the palette's names and refuses anything the app would show as gray", () => {
    expect(decodeCreate({ name: "Spawn", color: "blue" })).toEqual({
      name: "Spawn",
      color: "blue",
    });
    expect(() => decodeCreate({ name: "Spawn", color: "#3b82f6" })).toThrow();
    expect(() => decodeUpdate({ id: "label-1", color: "navy" })).toThrow();
    expect(decodeUpdate({ id: "label-1", color: null })).toEqual({ id: "label-1", color: null });
  });

  it("still reads a label whose stored color predates the palette", () => {
    const label = decodeLabel({
      id: "label-1",
      name: "Old",
      color: "#3b82f6",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      repositoryIds: [],
      threadCount: 0,
    });
    expect(label.color).toBe("#3b82f6");
  });
});

const decodeSourceLink = Schema.decodeUnknownSync(ProjectSourceLink);
const decodeSourceLinkInput = Schema.decodeUnknownSync(ProjectLabelSourceLinkInput);
const decodeLabel = Schema.decodeUnknownSync(ProjectLabelWithRepositories);
const encodeLabel = Schema.encodeSync(ProjectLabelWithRepositories);
const decodeSearchInput = Schema.decodeUnknownSync(ProjectLabelOwnerRepositorySearchInput);
const decodeCloneInput = Schema.decodeUnknownSync(ProjectLabelCloneRepositoryInput);

describe("project source links", () => {
  it("decodes owner and repository links", () => {
    expect(decodeSourceLink({ kind: "github-owner", owner: "spawn-partners" })).toEqual({
      kind: "github-owner",
      owner: "spawn-partners",
    });
    expect(
      decodeSourceLink({ kind: "github-repo", owner: "spawn-partners", repo: "acme.web" }),
    ).toEqual({ kind: "github-repo", owner: "spawn-partners", repo: "acme.web" });
  });

  it("rejects owners and repos outside the GitHub shape", () => {
    expect(() => decodeSourceLink({ kind: "github-owner", owner: "-lead" })).toThrow();
    expect(() => decodeSourceLink({ kind: "github-owner", owner: "has space" })).toThrow();
    expect(() => decodeSourceLink({ kind: "github-owner", owner: "a".repeat(40) })).toThrow();
    expect(() =>
      decodeSourceLink({ kind: "github-repo", owner: "spawn-partners", repo: "a/b" }),
    ).toThrow();
    expect(() =>
      decodeSourceLink({ kind: "github-repo", owner: "spawn-partners", repo: "" }),
    ).toThrow();
  });

  it("decodes labels that predate source links with none", () => {
    const decoded = decodeLabel({
      id: "label:1",
      name: "Spawn Partners",
      repositoryIds: [],
      threadCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(decoded.sourceLinks).toEqual([]);
  });

  it("decodes a source link mutation", () => {
    expect(
      decodeSourceLinkInput({
        id: "label:1",
        link: { kind: "github-owner", owner: "spawn-partners" },
      }).link,
    ).toEqual({ kind: "github-owner", owner: "spawn-partners" });
  });
});

describe("project repository links", () => {
  it("carries each repository's normalized remote and directory name", () => {
    const decoded = decodeLabel({
      id: "label:1",
      name: "Spawn Partners",
      repositoryIds: ["repo-1", "repo-2"],
      repositories: [
        { repositoryId: "repo-1", remote: "github.com/spawn/platform", directoryName: "platform" },
        { repositoryId: "repo-2", remote: null, directoryName: "local-notes" },
      ],
      sourceLinks: [{ kind: "github-owner", owner: "spawn" }],
      threadCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(decoded.repositories).toEqual([
      { repositoryId: "repo-1", remote: "github.com/spawn/platform", directoryName: "platform" },
      { repositoryId: "repo-2", remote: null, directoryName: "local-notes" },
    ]);
  });

  it("still decodes a label from a server that predates repository links", () => {
    const decoded = decodeLabel({
      id: "label:1",
      name: "Spawn Partners",
      repositoryIds: [],
      threadCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(decoded.repositories).toBeUndefined();
  });

  it("names the active-run refusal for a move attempted mid-turn", () => {
    const error = new ProjectLabelError({ operation: "moveThread", reason: "thread_active" });
    expect(error.message).toContain("turn is running");
  });
});

describe("repository folder names", () => {
  const label = (
    owner: string | null,
    repositories: ReadonlyArray<{ remote: string | null; directoryName: string | null }>,
  ) => ({
    id: "label:1",
    name: "Spawn Partners",
    repositoryIds: repositories.map((_, index) => `repo-${index}`),
    repositories: repositories.map((link, index) => ({ repositoryId: `repo-${index}`, ...link })),
    sourceLinks: owner === null ? [] : [{ kind: "github-owner", owner }],
    threadCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  it("names a home-owner repository by its name and any other by owner/name", () => {
    expect(repositoryDirectoryNameFor("github.com/spawn-partners/platform", "Spawn-Partners")).toBe(
      "platform",
    );
    expect(repositoryDirectoryNameFor("github.com/bartr-app/platform", "Spawn-Partners")).toBe(
      "bartr-app/platform",
    );
    expect(repositoryDirectoryNameFor("github.com/aflekkas/athens-racing", null)).toBe(
      "aflekkas/athens-racing",
    );
    // The home owner is a GitHub owner: the same login on another host is not it.
    expect(repositoryDirectoryNameFor("gitlab.com/spawn-partners/platform", "spawn-partners")).toBe(
      "spawn-partners/platform",
    );
    // A local bare repository has no owner, only its name.
    expect(repositoryDirectoryNameFor("/srv/git/platform.git", "spawn-partners")).toBe("platform");
  });

  it("takes the project's linked GitHub owner as its home owner", () => {
    expect(
      projectHomeOwner([
        { kind: "github-repo", owner: "aflekkas", repo: "athens-racing" },
        { kind: "github-owner", owner: "Spawn-Partners" },
      ]),
    ).toBe("Spawn-Partners");
    expect(projectHomeOwner([{ kind: "github-repo", owner: "aflekkas", repo: "x" }])).toBeNull();
  });

  it("derives every folder on decode, so a stale or chosen name never survives", () => {
    const decoded = decodeLabel(
      label("spawn-partners", [
        { remote: "github.com/spawn-partners/platform", directoryName: "spawn-platform" },
        { remote: "github.com/bartr-app/platform", directoryName: "platform" },
        { remote: null, directoryName: "local-notes" },
      ]),
    );
    expect(decoded.repositories?.map((link) => link.directoryName)).toEqual([
      "platform",
      "bartr-app/platform",
      "local-notes",
    ]);
  });

  it("refuses to make or encode a project whose folder names disagree", () => {
    const decoded = decodeLabel(
      label("spawn-partners", [
        { remote: "github.com/spawn-partners/platform", directoryName: "platform" },
      ]),
    );
    const renamed = {
      ...decoded,
      repositories: (decoded.repositories ?? []).map((link) => ({
        ...link,
        directoryName: "mine",
      })),
    };
    expect(() => encodeLabel(renamed)).toThrow();
    expect(encodeLabel(decoded)).toMatchObject({
      repositories: [{ directoryName: "platform" }],
    });
  });
});

describe("project owner repository search", () => {
  it("defaults an absent limit and bounds query and limit", () => {
    expect(decodeSearchInput({ id: "label:1", query: "acme" })).toMatchObject({
      query: "acme",
    });
    expect(decodeSearchInput({ id: "label:1", query: "", limit: 50 }).limit).toBe(50);
    expect(() => decodeSearchInput({ id: "label:1", query: "acme", limit: 51 })).toThrow();
    expect(() => decodeSearchInput({ id: "label:1", query: "a".repeat(101) })).toThrow();
  });
});

describe("project clone into repository input", () => {
  it("needs only the project; the server fills in the rest", () => {
    expect(decodeCloneInput({ id: "label:1" })).toMatchObject({ id: "label:1" });
    expect(
      decodeCloneInput({
        id: "label:1",
        repository: "spawn-partners/acme",
        protocol: "ssh",
      }),
    ).toMatchObject({ repository: "spawn-partners/acme", protocol: "ssh" });
  });
});

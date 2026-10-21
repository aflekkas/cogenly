import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectLabelCloneRepositoryInput,
  ProjectLabelOwnerRepositorySearchInput,
  ProjectLabelSourceLinkInput,
  ProjectLabelWithRepositories,
  ProjectSourceLink,
} from "./projectLabel.ts";

const decodeSourceLink = Schema.decodeUnknownSync(ProjectSourceLink);
const decodeSourceLinkInput = Schema.decodeUnknownSync(ProjectLabelSourceLinkInput);
const decodeLabel = Schema.decodeUnknownSync(ProjectLabelWithRepositories);
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

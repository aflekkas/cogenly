import { detectSourceControlProviderFromRemoteUrl, isSshRemoteUrl } from "./sourceControl.ts";
import { SourceControlProviderKind } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  sourceControlRepositorySelector,
  resolveChangeRequestPresentation,
} from "./sourceControl.ts";

describe("source control presentation", () => {
  it("falls back to generic change request copy for unknown providers", () => {
    expect(
      resolveChangeRequestPresentation({
        kind: SourceControlProviderKind.make("unknown"),
        name: "forge",
        baseUrl: "",
      }),
    ).toEqual(
      expect.objectContaining({
        shortName: "change request",
        longName: "change request",
      }),
    );
  });
});

describe("detectSourceControlProviderFromRemoteUrl", () => {
  it("keeps unsupported hosts available as plain git", () => {
    for (const remote of [
      "https://gitlab.com/team/repo.git",
      "git@bitbucket.org:team/repo.git",
      "https://codeberg.org/team/repo.git",
    ])
      expect(detectSourceControlProviderFromRemoteUrl(remote)?.kind).toBe("unknown");
    expect(detectSourceControlProviderFromRemoteUrl("git@github.com:team/repo.git")?.kind).toBe(
      "github",
    );
  });
});

describe("isSshRemoteUrl", () => {
  it("recognizes SSH and HTTPS protocols", () => {
    expect(isSshRemoteUrl("deploy@example.com:team/repo.git")).toBe(true);
    expect(isSshRemoteUrl("https://example.com/team/repo.git")).toBe(false);
  });
});

it("puts owner and name back together for an identity recorded before displayName", () => {
  const selector = sourceControlRepositorySelector({
    provider: "github",
    owner: "t3tools",
    name: "t3code",
  });
  expect(selector).toBe("t3tools/t3code");
});

it("names nothing for a project with no remote to name it by", () => {
  expect(sourceControlRepositorySelector(null)).toBeNull();
  expect(sourceControlRepositorySelector({ provider: "github" })).toBeNull();
});

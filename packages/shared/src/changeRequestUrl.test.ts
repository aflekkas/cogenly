import { changeRequestUrlFor } from "./changeRequestUrl.ts";
import { describe, expect, it } from "vite-plus/test";

import {
  parseChangeRequestUrl,
  pullRequestCandidateUrlFromReferenceAutolink,
  siblingPullRequestUrl,
} from "./changeRequestUrl.ts";

describe("parseChangeRequestUrl", () => {
  it("reads a GitHub pull request, lower-casing the repository", () => {
    expect(parseChangeRequestUrl("https://github.com/T3Tools/T3Code/pull/123")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
  });

  it("reads a pull request on a GitHub Enterprise host", () => {
    expect(parseChangeRequestUrl("https://github.acme.test/platform/api/pull/7")).toEqual({
      host: "github.acme.test",
      repository: "platform/api",
      number: 7,
    });
  });

  it("reads a supported GitHub host with a middle DNS label", () => {
    expect(parseChangeRequestUrl("https://code.github.example.com/acme/web/pull/42")).toEqual({
      host: "code.github.example.com",
      repository: "acme/web",
      number: 42,
    });
    expect(
      pullRequestCandidateUrlFromReferenceAutolink(
        "https://code.github.example.com/acme/web/issues/42",
      ),
    ).toBe("https://code.github.example.com/acme/web/pull/42");
  });

  it("survives trailing segments, a trailing slash and a query string", () => {
    expect(parseChangeRequestUrl("https://github.com/t3tools/t3code/pull/123/files?w=1")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
    expect(parseChangeRequestUrl("https://github.com/t3tools/t3code/pull/123/")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
  });
});

describe("siblingPullRequestUrl", () => {
  it("rejects non-PR URLs and invalid numbers", () => {
    expect(siblingPullRequestUrl("https://github.com/acme/web/issues/42", 43)).toBeNull();
    expect(siblingPullRequestUrl("https://github.com/acme/web/pull/42", 0)).toBeNull();
  });
});

describe("changeRequestUrlFor", () => {
  it("builds GitHub links and declines unsupported hosts", () => {
    expect(changeRequestUrlFor("github", "github.com", "team/repo", 7)).toBe(
      "https://github.com/team/repo/pull/7",
    );
    expect(changeRequestUrlFor("unknown", "example.com", "team/repo", 7)).toBeNull();
  });
});

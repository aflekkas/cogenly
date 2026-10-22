import { describe, expect, it } from "vite-plus/test";

import {
  digestReleaseNotes,
  formatReleaseDay,
  parseGitHubReleases,
  parseReleaseNotesBody,
  releaseHistory,
  releasesBetween,
} from "./releaseNotes.logic";

function release(tag: string, body = "", overrides: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    html_url: `https://github.com/aflekkas/cogenly/releases/tag/${tag}`,
    published_at: "2026-10-22T10:05:39Z",
    draft: false,
    prerelease: false,
    body,
    ...overrides,
  };
}

describe("parseReleaseNotesBody", () => {
  it("keeps headed bullets and stops at the build section", () => {
    const body = [
      "## New",
      "",
      "- Voice dictation in the composer (⌘⇧D)",
      "",
      "## Fixes",
      "",
      "- Fixed **No conversation found** when resuming [Claude](https://claude.com) chats",
      "",
      "## Build",
      "",
      "- not a change",
    ].join("\n");
    expect(parseReleaseNotesBody(body)).toEqual([
      { title: "New", items: ["Voice dictation in the composer (⌘⇧D)"] },
      { title: "Fixes", items: ["Fixed No conversation found when resuming Claude chats"] },
    ]);
  });

  it("reads GitHub's generated notes without their attributions", () => {
    const body = [
      "## What's Changed",
      "* feat: a thing by @someone in https://github.com/aflekkas/cogenly/pull/3",
      "* fix: another (abc1234)",
      "",
      "**Full Changelog**: https://github.com/aflekkas/cogenly/compare/v0.1.0...v0.1.1",
      "Build: `abc` • Signing: **unsigned**",
    ].join("\n");
    expect(parseReleaseNotesBody(body)).toEqual([
      { title: null, items: ["feat: a thing", "fix: another"] },
    ]);
  });
});

describe("parseGitHubReleases", () => {
  it("keeps published prod releases, newest first", () => {
    const releases = parseGitHubReleases([
      release("v0.1.1", "- One"),
      release("v0.1.10"),
      release("v0.1.0-staging.20261022.206", "", { prerelease: true }),
      release("v0.2.0", "", { draft: true }),
      release("v0.1.2"),
      { tag_name: 3 },
      null,
    ]);
    expect(releases.map((entry) => entry.version)).toEqual(["0.1.10", "0.1.2", "0.1.1"]);
    expect(releases[2]?.sections).toEqual([{ title: null, items: ["One"] }]);
    expect(parseGitHubReleases({ message: "API rate limit exceeded" })).toEqual([]);
  });
});

describe("release ranges", () => {
  const releases = parseGitHubReleases(
    ["v0.1.3", "v0.1.2", "v0.1.1", "v0.1.0"].map((tag) => release(tag)),
  );
  const versions = (list: ReadonlyArray<{ version: string }>) => list.map((entry) => entry.version);

  it("an update shows every release after the installed one up to the target", () => {
    expect(versions(releasesBetween(releases, "0.1.0", "0.1.2"))).toEqual(["0.1.2", "0.1.1"]);
    expect(versions(releasesBetween(releases, null, "0.1.1"))).toEqual(["0.1.1", "0.1.0"]);
    expect(releasesBetween(releases, "0.1.0", "not-a-version")).toEqual([]);
  });

  it("history starts at the installed version; a dev build sees everything", () => {
    expect(versions(releaseHistory(releases, "0.1.2"))).toEqual(["0.1.2", "0.1.1", "0.1.0"]);
    expect(versions(releaseHistory(releases, "0.0.0"))).toHaveLength(4);
    expect(versions(releaseHistory(releases, "0.0.0-dev"))).toEqual([
      "0.1.3",
      "0.1.2",
      "0.1.1",
      "0.1.0",
    ]);
  });
});

describe("digestReleaseNotes", () => {
  const releases = parseGitHubReleases([
    release("v0.1.3", "## New\n- A\n- B\n## Fixes\n- C"),
    release("v0.1.2", ""),
    release("v0.1.1", "- D\n- E"),
  ]);

  it("takes the first bullets across releases and counts the rest", () => {
    const digest = digestReleaseNotes(releases, 4);
    expect(digest.groups.map(({ release, items }) => [release.version, items])).toEqual([
      ["0.1.3", ["A", "B", "C"]],
      ["0.1.2", []],
      ["0.1.1", ["D"]],
    ]);
    expect(digest.remaining).toBe(1);
  });

  it("leaves out releases past the limit", () => {
    const digest = digestReleaseNotes(releases, 2);
    expect(digest.groups.map(({ release }) => release.version)).toEqual(["0.1.3"]);
    expect(digest.remaining).toBe(3);
  });
});

describe("formatReleaseDay", () => {
  it("names today and yesterday, else the date", () => {
    const now = new Date(2026, 9, 22, 15, 0);
    expect(formatReleaseDay(new Date(2026, 9, 22, 1, 0).toISOString(), now)).toBe("Today");
    expect(formatReleaseDay(new Date(2026, 9, 21, 23, 0).toISOString(), now)).toBe("Yesterday");
    expect(formatReleaseDay(new Date(2026, 9, 1, 12, 0).toISOString(), now)).toMatch(/1/);
    expect(formatReleaseDay(null, now)).toBeNull();
    expect(formatReleaseDay("not a date", now)).toBeNull();
  });
});

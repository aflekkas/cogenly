import {
  type EnvironmentId,
  ProjectId,
  ProjectLabelId,
  type ProjectLabelOwnerRepository,
  type ProjectLabelRepositoryLink,
  type ProjectLabelWithRepositories,
  type ProjectSourceLink,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectLabelKey, type EnvironmentProjectLabel } from "./projectLabels.logic";
import {
  addRepositoryOptions,
  canMoveIntoProjectFolder,
  canRemoveCheckout,
  describeCloneFailure,
  gitHubRepositoryKeys,
  gitHubRepositoryOf,
  isRepositoryRequestSettled,
  linkedRepositoryRows,
  machineRepositoryRows,
  projectRepositoryLinks,
  REMOTE_ROWS_PREVIEW_LIMIT,
  remoteRowsOutsideProject,
  repositoryRowAction,
  repositoryRowView,
  type RepositoryListLocal,
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

const mac = "mac" as EnvironmentId;

function link(
  repositoryId: string,
  remote: string | null,
  directoryName: string | null,
  checkout?: ProjectLabelRepositoryLink["checkout"],
): ProjectLabelRepositoryLink {
  return {
    repositoryId: ProjectId.make(repositoryId),
    remote,
    directoryName,
    ...(checkout ? { checkout } : {}),
  };
}

function project(
  id: string,
  name: string,
  links: ReadonlyArray<ProjectLabelRepositoryLink> | undefined,
  sourceLinks: ReadonlyArray<ProjectSourceLink> = [],
  repositoryIds: ReadonlyArray<string> = links?.map((entry) => entry.repositoryId) ?? [],
): EnvironmentProjectLabel {
  const label: ProjectLabelWithRepositories = {
    id: ProjectLabelId.make(id),
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    repositoryIds: repositoryIds.map((repositoryId) => ProjectId.make(repositoryId)),
    ...(links ? { repositories: links } : {}),
    sourceLinks,
    threadCount: 0,
    instructions: "",
    projectChatThreadId: null,
  };
  return { key: projectLabelKey(mac, id), environmentId: mac, label };
}

function local(
  id: string,
  title: string,
  workspaceRoot: string,
  canonicalKey?: string,
): RepositoryListLocal {
  return {
    id: ProjectId.make(id),
    title,
    workspaceRoot,
    ...(canonicalKey ? { repositoryIdentity: identity(canonicalKey) } : {}),
  };
}

const spawnOwner: ProjectSourceLink = { kind: "github-owner", owner: "Spawn-Partners" };
const spawn = project(
  "spawn",
  "Spawn Partners",
  [
    link("platform-id", "github.com/Spawn-Partners/platform", "platform", "ready"),
    link(
      "remote:github.com/aflekkas/athens-racing",
      "github.com/aflekkas/athens-racing",
      "aflekkas/athens-racing",
      "not_cloned",
    ),
    link("finance-id", "github.com/Spawn-Partners/finance", "finance", "missing"),
    link("cloning-id", "github.com/Spawn-Partners/site", "site", "cloning"),
    link("notes-id", null, "notes"),
  ],
  [spawnOwner],
);
const bartr = project(
  "bartr",
  "Bartr",
  [link("bartr-platform-id", "github.com/bartr-app/platform", "platform", "ready")],
  [{ kind: "github-owner", owner: "bartr-app" }],
);
const platformCheckout = local(
  "platform-id",
  "platform",
  "/Users/me/Projects/Spawn Partners/repos/platform",
  "github.com/Spawn-Partners/platform",
);
const bartrCheckout = local(
  "bartr-platform-id",
  "Bartr Platform",
  "/Users/me/Code/bartr-platform",
  "github.com/bartr-app/platform",
);
const notesCheckout = local("notes-id", "notes", "/Users/me/Projects/Spawn Partners/repos/notes");
const looseCheckout = local("loose-id", "loose", "/Users/me/Code/loose");
const byId = (locals: ReadonlyArray<RepositoryListLocal>) =>
  new Map(locals.map((entry) => [entry.id as string, entry] as const));

describe("linkedRepositoryRows", () => {
  const rows = linkedRepositoryRows({
    project: spawn,
    localById: byId([platformCheckout, notesCheckout]),
  });

  it("lists every linked repository once, flat and by name, whatever its state here", () => {
    expect(rows.map((row) => [row.name, row.checkout])).toEqual([
      ["aflekkas/athens-racing", "not_cloned"],
      ["finance", "missing"],
      ["notes", "ready"],
      ["platform", "ready"],
      ["site", "cloning"],
    ]);
    // The overview's count is this list's length.
    expect(projectRepositoryLinks(spawn.label)).toHaveLength(rows.length);
  });

  it("names each by its folder under repos/ and keeps another machine's link record-free", () => {
    const athens = rows.find((row) => row.name === "aflekkas/athens-racing");
    expect(athens).toMatchObject({
      repositoryId: null,
      // Unlinking names the placeholder, so it works before any clone here.
      linkId: "remote:github.com/aflekkas/athens-racing",
      local: null,
      remote: "github.com/aflekkas/athens-racing",
      detail: null,
      key: "remote:github.com/aflekkas/athens-racing",
    });
    expect(rows.find((row) => row.name === "platform")?.local).toBe(platformCheckout);
  });

  it("leads with the draft's repository", () => {
    const led = linkedRepositoryRows({
      project: spawn,
      localById: byId([platformCheckout]),
      leadRepositoryId: ProjectId.make("platform-id"),
    });
    expect(led[0]?.name).toBe("platform");
  });

  it("reads an older server's ids as links: a record is cloned, a placeholder is not", () => {
    const old = project("old", "Old", undefined, [], ["platform-id", "remote:github.com/spawn/x"]);
    const oldRows = linkedRepositoryRows({ project: old, localById: byId([platformCheckout]) });
    expect(oldRows.map((row) => [row.name, row.checkout, row.remote])).toEqual([
      ["platform", "ready", null],
      // Its remote comes from the placeholder id, so it can still be cloned here.
      ["x", "not_cloned", "github.com/spawn/x"],
    ]);
  });

  it("tells same-named repositories apart by owner, never by renaming", () => {
    const mixed = project(
      "mixed",
      "Mixed",
      [link("a", "github.com/Spawn-Partners/platform", "platform"), link("b", null, "platform")],
      [spawnOwner],
    );
    const named = linkedRepositoryRows({ project: mixed, localById: new Map() });
    expect(named.map((row) => [row.name, row.detail])).toEqual([
      ["platform", "No remote"],
      ["platform", "Spawn-Partners"],
    ]);
  });
});

describe("machineRepositoryRows", () => {
  const rows = machineRepositoryRows({
    locals: [bartrCheckout, platformCheckout, looseCheckout],
    projects: [bartr, spawn],
  });

  it("lists the machine's repositories, a linked one named and stated as its project has it", () => {
    expect(rows.map((row) => row.name)).toEqual(["loose", "platform", "platform"]);
    expect(rows.find((row) => row.local === looseCheckout)).toMatchObject({
      project: null,
      checkout: "ready",
      detail: null,
    });
  });

  it("tells two projects' platform apart by project", () => {
    expect(
      rows.filter((row) => row.name === "platform").map((row) => [row.detail, row.local?.id]),
    ).toEqual([
      ["Bartr", "bartr-platform-id"],
      ["Spawn Partners", "platform-id"],
    ]);
  });
});

describe("row actions", () => {
  const rows = linkedRepositoryRows({
    project: spawn,
    localById: byId([platformCheckout]),
  });
  const named = (name: string) => rows.find((row) => row.name === name)!;

  it("picks a cloned repository, clones one that is not here, waits on one cloning", () => {
    expect(repositoryRowAction(named("platform"))).toBe("select");
    expect(repositoryRowAction(named("aflekkas/athens-racing"))).toBe("checkout");
    expect(repositoryRowAction(named("finance"))).toBe("checkout");
    expect(repositoryRowAction(named("site"))).toBe("wait");
    // Linked and cloned, but its record has not reached this window yet.
    expect(repositoryRowAction(named("notes"))).toBe("wait");
  });

  it("offers Remove from this machine only for a cloned repository with a remote", () => {
    expect(canRemoveCheckout(named("platform"))).toBe(true);
    expect(canRemoveCheckout(named("aflekkas/athens-racing"))).toBe(false);
    expect(canRemoveCheckout({ ...named("notes"), local: notesCheckout })).toBe(false);
  });

  it("offers Move into project folder only for a checkout outside repos/<name>", () => {
    expect(canMoveIntoProjectFolder(named("platform"))).toBe(false);
    const elsewhere = { ...named("platform"), local: bartrCheckout };
    expect(canMoveIntoProjectFolder(elsewhere)).toBe(true);
    expect(canMoveIntoProjectFolder(named("aflekkas/athens-racing"))).toBe(false);
    expect(
      canMoveIntoProjectFolder({
        ...named("platform"),
        local: local("platform-id", "platform", "C:\\Projects\\Spawn\\repos\\platform\\"),
      }),
    ).toBe(false);
  });
});

describe("repositoryRowView", () => {
  const clone = (
    phase: "running" | "failed" | "done",
    sequence: number,
    error: string | null = null,
  ) => ({ phase, stage: "receiving" as const, percent: 42, detail: null, error, sequence });

  it("reads the link's state when nothing was asked here", () => {
    expect(repositoryRowView({ checkout: "ready" }, null, null)).toEqual({ kind: "ready" });
    expect(repositoryRowView({ checkout: "not_cloned" }, null, null)).toEqual({
      kind: "needs-clone",
      cloneable: true,
    });
    expect(repositoryRowView({ checkout: "missing" }, null, null)).toEqual({
      kind: "needs-clone",
      cloneable: true,
    });
    expect(repositoryRowView({ checkout: "failed" }, null, clone("failed", 3, "boom"))).toEqual({
      kind: "failed",
      message: "boom",
      cloneable: true,
    });
  });

  it("promises no clone where picking the row cannot start one", () => {
    expect(repositoryRowView({ checkout: "missing" }, null, null, { cloneable: false })).toEqual({
      kind: "needs-clone",
      cloneable: false,
    });
  });

  it("shows a removal or move this client runs over everything else", () => {
    expect(
      repositoryRowView({ checkout: "ready" }, null, null, { cloneable: true, work: "removing" }),
    ).toEqual({ kind: "working", work: "removing" });
  });

  it("shows git's own progress while the clone runs, and no number it does not have", () => {
    const running = repositoryRowView({ checkout: "cloning" }, null, clone("running", 1));
    expect(running.kind).toBe("cloning");
    expect(running.kind === "cloning" ? running.progress : null).toContain("42%");
    expect(repositoryRowView({ checkout: "cloning" }, null, null)).toEqual({
      kind: "cloning",
      progress: null,
    });
  });

  it("starts, then follows the server, never mistaking the older failure for the retry", () => {
    const repositoryId = ProjectId.make("finance-id");
    expect(repositoryRowView({ checkout: "failed" }, { phase: "starting" }, null)).toEqual({
      kind: "starting",
    });
    const started = { phase: "started" as const, repositoryId, baselineSequence: 3 };
    expect(repositoryRowView({ checkout: "failed" }, started, clone("failed", 3, "old"))).toEqual({
      kind: "starting",
    });
    expect(repositoryRowView({ checkout: "failed" }, started, clone("failed", 7, "new"))).toEqual({
      kind: "failed",
      message: "new",
      cloneable: true,
    });
    expect(repositoryRowView({ checkout: "ready" }, started, null)).toEqual({ kind: "ready" });
  });

  it("lets the server speak once it has overtaken the request", () => {
    const repositoryId = ProjectId.make("finance-id");
    const started = { phase: "started" as const, repositoryId, baselineSequence: null };
    // Cloned, then removed from this machine: the old request no longer reads as starting.
    expect(isRepositoryRequestSettled({ checkout: "ready" }, started, null)).toBe(true);
    expect(isRepositoryRequestSettled({ checkout: "missing" }, started, clone("done", 1))).toBe(
      true,
    );
    expect(repositoryRowView({ checkout: "missing" }, started, clone("done", 1))).toEqual({
      kind: "needs-clone",
      cloneable: true,
    });
    // Before the server reports anything, the request still holds.
    expect(isRepositoryRequestSettled({ checkout: "missing" }, started, null)).toBe(false);
    expect(isRepositoryRequestSettled({ checkout: "missing" }, { phase: "starting" }, null)).toBe(
      false,
    );
  });

  it("shows a refused clone with the server's words, until it is cloned some other way", () => {
    const refused = { phase: "error" as const, message: "No access." };
    expect(repositoryRowView({ checkout: "not_cloned" }, refused, null)).toEqual({
      kind: "failed",
      message: "No access.",
      cloneable: true,
    });
    expect(repositoryRowView({ checkout: "ready" }, refused, null)).toEqual({ kind: "ready" });
  });
});

describe("addRepositoryOptions", () => {
  const many = Array.from({ length: REMOTE_ROWS_PREVIEW_LIMIT + 3 }, (_, index) =>
    repo(`Spawn-Partners/repo-${index}`),
  );

  it("offers this machine's other repositories, then GitHub's, named as they will be", () => {
    const { options } = addRepositoryOptions({
      project: spawn,
      locals: [platformCheckout, bartrCheckout, looseCheckout],
      folderOf: (candidate) => (candidate.id === bartrCheckout.id ? bartr : null),
      gitHub: [
        repo("Spawn-Partners/platform"),
        repo("aflekkas/athens-racing"),
        repo("Spawn-Partners/billing"),
        repo("mediamaxxing/billing"),
      ],
      searching: false,
      expanded: false,
    });
    expect(
      options.map((option) => [
        option.kind,
        option.name,
        option.kind === "local" ? (option.from?.label.name ?? null) : null,
      ]),
    ).toEqual([
      ["local", "Bartr Platform", "Bartr"],
      ["local", "loose", null],
      ["github", "billing", null],
      ["github", "mediamaxxing/billing", null],
    ]);
  });

  it("previews a few GitHub results until expanded or searched", () => {
    const preview = addRepositoryOptions({
      project: spawn,
      locals: [],
      folderOf: () => null,
      gitHub: many,
      searching: false,
      expanded: false,
    });
    expect(preview.options).toHaveLength(REMOTE_ROWS_PREVIEW_LIMIT);
    expect(preview.hidden).toBe(3);
    for (const mode of [
      { searching: true, expanded: false },
      { searching: false, expanded: true },
    ]) {
      const all = addRepositoryOptions({
        project: spawn,
        locals: [],
        folderOf: () => null,
        gitHub: many,
        ...mode,
      });
      expect(all.options).toHaveLength(many.length);
      expect(all.hidden).toBe(0);
    }
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

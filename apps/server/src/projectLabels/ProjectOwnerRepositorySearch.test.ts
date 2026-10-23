import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProjectLabelError,
  ProjectLabelId,
  type ProjectLabelWithRepositories,
} from "@t3tools/contracts";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as Effect from "effect/Effect";

import {
  mapGitHubOwnerRepositoryRow,
  matchesOwnerRepositoryQuery,
  searchLabelOwnerRepositories,
  type ProjectOwnerRepositorySearchDeps,
} from "./ProjectOwnerRepositorySearch.ts";

const labelId = ProjectLabelId.make("label:spawn");
const labelWithOwners = (...owners: ReadonlyArray<string>): ProjectLabelWithRepositories => ({
  id: labelId,
  name: "Spawn Partners",
  repositoryIds: [],
  sourceLinks: owners.map((owner) => ({ kind: "github-owner" as const, owner })),
  threadCount: 0,
  instructions: "",
  projectChatThreadId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const gitHubRow = (overrides: Record<string, unknown> = {}) => ({
  name: "acme",
  full_name: "spawn-partners/acme",
  owner: { login: "spawn-partners" },
  description: "Acme services",
  private: false,
  default_branch: "main",
  pushed_at: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const restResponse = (body: string) => ({
  status: 200,
  headers: {},
  body,
  truncated: false,
  invalidUtf8: false,
});

describe("mapGitHubOwnerRepositoryRow", () => {
  it("maps a full row", () => {
    expect(mapGitHubOwnerRepositoryRow(gitHubRow(), true)).toEqual({
      owner: "spawn-partners",
      name: "acme",
      nameWithOwner: "spawn-partners/acme",
      description: "Acme services",
      private: false,
      defaultBranch: "main",
      pushedAt: "2026-10-01T00:00:00.000Z",
      alreadyLocal: true,
    });
  });

  it("nulls absent branches and pushes", () => {
    expect(
      mapGitHubOwnerRepositoryRow(
        gitHubRow({ default_branch: null, pushed_at: null, description: null }),
        false,
      ),
    ).toMatchObject({ defaultBranch: null, pushedAt: null, description: null });
  });

  it("drops rows without an owner or name", () => {
    expect(mapGitHubOwnerRepositoryRow(gitHubRow({ name: "  " }), false)).toBe(null);
    expect(mapGitHubOwnerRepositoryRow(gitHubRow({ owner: { login: "" } }), false)).toBe(null);
    expect(mapGitHubOwnerRepositoryRow({ nope: true }, false)).toBe(null);
  });
});

describe("matchesOwnerRepositoryQuery", () => {
  it("matches case-insensitive substrings, and everything when empty", () => {
    expect(matchesOwnerRepositoryQuery("Acme-Web", "acme")).toBe(true);
    expect(matchesOwnerRepositoryQuery("Acme-Web", "CME-w")).toBe(true);
    expect(matchesOwnerRepositoryQuery("Acme-Web", "billing")).toBe(false);
    expect(matchesOwnerRepositoryQuery("Acme-Web", "   ")).toBe(true);
  });
});

describe("searchLabelOwnerRepositories", () => {
  const projectRow = (projectId: string, workspaceRoot: string) => ({
    projectId: ProjectId.make(projectId),
    title: projectId,
    workspaceRoot,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  });

  const depsWith = (options: {
    readonly label: ProjectLabelWithRepositories;
    readonly rest: ProjectOwnerRepositorySearchDeps["github"]["rest"];
    readonly projects?: ReadonlyArray<ReturnType<typeof projectRow>>;
    readonly identities?: Record<string, { owner: string; name: string } | null>;
  }): ProjectOwnerRepositorySearchDeps => ({
    labels: { read: () => Effect.succeed({ label: options.label }) },
    github: { rest: options.rest },
    projects: { list: () => Effect.succeed(options.projects ?? []) },
    identities: {
      resolve: (cwd) => {
        const identity = options.identities?.[cwd] ?? null;
        return Effect.succeed(
          identity === null
            ? null
            : {
                canonicalKey: `github.com/${identity.owner}/${identity.name}`,
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: "https://github.com/x/y.git",
                },
                provider: "github",
                owner: identity.owner,
                name: identity.name,
              },
        );
      },
    },
  });

  it.effect("lists the signed-in account's repositories when the project links no owners", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const rest: ProjectOwnerRepositorySearchDeps["github"]["rest"] = (input) =>
        Effect.sync(() => void seen.push(input.path)).pipe(
          Effect.as(
            restResponse(
              JSON.stringify([
                gitHubRow({ name: "acme-web", owner: { login: "aflekkas" } }),
                gitHubRow({ name: "billing", owner: { login: "aflekkas" } }),
              ]),
            ),
          ),
        );
      const result = yield* searchLabelOwnerRepositories(
        { id: labelId, query: "acme" },
        depsWith({ label: labelWithOwners(), rest }),
      );
      expect(seen).toEqual([expect.stringContaining("user/repos?")]);
      expect(result.repositories.map((repo) => repo.nameWithOwner)).toEqual(["aflekkas/acme-web"]);
    }),
  );

  it.effect("searches each linked owner and filters by query", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const rest: ProjectOwnerRepositorySearchDeps["github"]["rest"] = (input) =>
        Effect.succeed(
          restResponse(
            JSON.stringify([
              gitHubRow({ name: "acme-web" }),
              gitHubRow({ name: "billing", private: true }),
            ]),
          ),
        ).pipe(Effect.tap(() => Effect.sync(() => void seen.push(input.path))));
      const result = yield* searchLabelOwnerRepositories(
        { id: labelId, query: "ACME" },
        depsWith({ label: labelWithOwners("spawn-partners", "other-org"), rest }),
      );
      expect(seen).toHaveLength(2);
      expect(seen).toContainEqual(expect.stringContaining("orgs/spawn-partners/repos"));
      expect(seen).toContainEqual(expect.stringContaining("orgs/other-org/repos"));
      expect(result.repositories.map((repo) => repo.name)).toEqual(["acme-web"]);
    }),
  );

  it.effect("marks repositories that already exist locally", () =>
    Effect.gen(function* () {
      const rest: ProjectOwnerRepositorySearchDeps["github"]["rest"] = () =>
        Effect.succeed(
          restResponse(
            JSON.stringify([
              gitHubRow({ name: "acme" }),
              gitHubRow({ name: "fresh", owner: { login: "spawn-partners" } }),
            ]),
          ),
        );
      const result = yield* searchLabelOwnerRepositories(
        { id: labelId, query: "" },
        depsWith({
          label: labelWithOwners("spawn-partners"),
          rest,
          projects: [projectRow("repo-a", "/repos/a")],
          identities: { "/repos/a": { owner: "Spawn-Partners", name: "ACME" } },
        }),
      );
      expect(result.repositories).toMatchObject([
        { nameWithOwner: "spawn-partners/acme", alreadyLocal: true },
        { nameWithOwner: "spawn-partners/fresh", alreadyLocal: false },
      ]);
    }),
  );

  it.effect("counts a fork's own remote as local, not only its upstream", () =>
    Effect.gen(function* () {
      const rest: ProjectOwnerRepositorySearchDeps["github"]["rest"] = () =>
        Effect.succeed(restResponse(JSON.stringify([gitHubRow({ name: "acme" })])));
      const deps = depsWith({
        label: labelWithOwners("spawn-partners"),
        rest,
        projects: [projectRow("fork", "/repos/fork")],
      });
      const result = yield* searchLabelOwnerRepositories(
        { id: labelId, query: "" },
        {
          ...deps,
          identities: {
            resolve: () =>
              Effect.succeed({
                canonicalKey: "github.com/upstream/acme",
                locator: {
                  source: "git-remote" as const,
                  remoteName: "upstream",
                  remoteUrl: "https://github.com/upstream/acme.git",
                },
                owner: "upstream",
                name: "acme",
                origin: { canonicalKey: "github.com/spawn-partners/acme" },
              }),
          },
        },
      );
      expect(result.repositories).toMatchObject([
        { nameWithOwner: "spawn-partners/acme", alreadyLocal: true },
      ]);
    }),
  );

  it.effect("caps results at the requested limit", () =>
    Effect.gen(function* () {
      const rest: ProjectOwnerRepositorySearchDeps["github"]["rest"] = () =>
        Effect.succeed(
          restResponse(JSON.stringify([gitHubRow({ name: "one" }), gitHubRow({ name: "two" })])),
        );
      const result = yield* searchLabelOwnerRepositories(
        { id: labelId, query: "", limit: 1 },
        depsWith({ label: labelWithOwners("spawn-partners"), rest }),
      );
      expect(result.repositories).toHaveLength(1);
    }),
  );

  it.effect("falls back to the user endpoint for non-organizations", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const rest: ProjectOwnerRepositorySearchDeps["github"]["rest"] = (input) =>
        Effect.sync(() => void seen.push(input.path)).pipe(
          Effect.flatMap(() =>
            input.path.startsWith("orgs/")
              ? Effect.fail(
                  new GitHubRequestPolicy.GitHubApiNotFoundError({
                    host: "github.com",
                    operation: "test",
                  }),
                )
              : Effect.succeed(restResponse(JSON.stringify([gitHubRow({ name: "solo" })]))),
          ),
        );
      const result = yield* searchLabelOwnerRepositories(
        { id: labelId, query: "" },
        depsWith({ label: labelWithOwners("someone"), rest }),
      );
      expect(seen).toEqual([
        expect.stringContaining("orgs/someone/repos"),
        expect.stringContaining("users/someone/repos"),
      ]);
      expect(result.repositories.map((repo) => repo.name)).toEqual(["solo"]);
    }),
  );

  it.effect("reports a graceful error when GitHub is not connected", () =>
    Effect.gen(function* () {
      const rest: ProjectOwnerRepositorySearchDeps["github"]["rest"] = () =>
        Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host: "github.com" }));
      const failure = yield* searchLabelOwnerRepositories(
        { id: labelId, query: "" },
        depsWith({ label: labelWithOwners("spawn-partners"), rest }),
      ).pipe(Effect.flip);
      expect(failure._tag).toBe("ProjectLabelOwnerSearchError");
      expect(failure).toMatchObject({ reason: "github_not_connected" });
    }),
  );

  it.effect("reports rate limits distinctly from outages", () =>
    Effect.gen(function* () {
      const limited: ProjectOwnerRepositorySearchDeps["github"]["rest"] = () =>
        Effect.fail(
          new GitHubRequestPolicy.GitHubApiRateLimitError({
            host: "github.com",
            operation: "test",
          }),
        );
      const outage: ProjectOwnerRepositorySearchDeps["github"]["rest"] = () =>
        Effect.fail(
          new GitHubRequestPolicy.GitHubApiRequestError({
            host: "github.com",
            operation: "test",
            cause: "socket hang up",
          }),
        );
      const deps = (rest: ProjectOwnerRepositorySearchDeps["github"]["rest"]) =>
        depsWith({ label: labelWithOwners("spawn-partners"), rest });
      const rateLimited = yield* searchLabelOwnerRepositories(
        { id: labelId, query: "" },
        deps(limited),
      ).pipe(Effect.flip);
      expect(rateLimited).toMatchObject({ reason: "github_rate_limited" });
      const unavailable = yield* searchLabelOwnerRepositories(
        { id: labelId, query: "" },
        deps(outage),
      ).pipe(Effect.flip);
      expect(unavailable).toMatchObject({ reason: "github_unavailable" });
    }),
  );

  it.effect("passes a missing project through", () =>
    Effect.gen(function* () {
      const deps = depsWith({
        label: labelWithOwners("spawn-partners"),
        rest: () => Effect.die(new Error("must not call GitHub")),
      });
      const missing = {
        ...deps,
        labels: {
          read: () =>
            Effect.fail(new ProjectLabelError({ operation: "read", reason: "not_found" })),
        },
      };
      const failure = yield* searchLabelOwnerRepositories({ id: labelId, query: "" }, missing).pipe(
        Effect.flip,
      );
      expect(failure._tag).toBe("ProjectLabelError");
    }),
  );
});

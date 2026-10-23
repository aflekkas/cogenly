import {
  PROJECT_LABEL_OWNER_SEARCH_DEFAULT_LIMIT,
  ProjectLabelError,
  ProjectLabelOwnerRepository,
  type ProjectLabelOwnerRepositorySearchInput,
  ProjectLabelOwnerSearchError,
} from "@t3tools/contracts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import type * as ProjectLabelService from "./ProjectLabelService.ts";

/** One REST page per owner; the picker debounces, so the call stays small and fast. */
const OWNER_REPOSITORIES_TIMEOUT = "8 seconds";
const OWNER_REPOSITORIES_PER_PAGE = 100;

const GitHubRepositoryListJson = Schema.fromJsonString(Schema.Array(Schema.Unknown));
const decodeRepositoryListJson = Schema.decodeUnknownOption(GitHubRepositoryListJson);

const GitHubOwnerRepositoryRow = Schema.Struct({
  name: Schema.String,
  owner: Schema.Struct({ login: Schema.String }),
  description: Schema.NullOr(Schema.String),
  private: Schema.Boolean,
  default_branch: Schema.NullOr(Schema.String),
  pushed_at: Schema.NullOr(Schema.String),
});
type GitHubOwnerRepositoryRow = typeof GitHubOwnerRepositoryRow.Type;
const decodeRepositoryRow = Schema.decodeUnknownOption(GitHubOwnerRepositoryRow);
const decodeOwnerRepository = Schema.decodeUnknownOption(ProjectLabelOwnerRepository);

/**
 * One GitHub repository row as the picker shows it. Null for a row this
 * cannot use, so one unexpected row cannot hide the rest.
 */
export function mapGitHubOwnerRepositoryRow(
  value: unknown,
  alreadyLocal: boolean,
): ProjectLabelOwnerRepository | null {
  const row = Option.getOrUndefined(decodeRepositoryRow(value));
  if (!row) return null;
  const owner = row.owner.login.trim();
  const name = row.name.trim();
  if (owner === "" || name === "") return null;
  const defaultBranch = row.default_branch?.trim() ?? "";
  return (
    Option.getOrUndefined(
      decodeOwnerRepository({
        owner,
        name,
        nameWithOwner: `${owner}/${name}`,
        description: row.description,
        private: row.private,
        defaultBranch: defaultBranch === "" ? null : defaultBranch,
        pushedAt: row.pushed_at,
        alreadyLocal,
      }),
    ) ?? null
  );
}

/** Case-insensitive substring match on the repository name; empty matches everything. */
export function matchesOwnerRepositoryQuery(name: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || name.toLowerCase().includes(needle);
}

const localRepositoryKey = (owner: string, name: string) =>
  `${owner.trim().toLowerCase()}/${name.trim().toLowerCase()}`;

function toSearchError(error: GitHubRequestPolicy.GitHubApiError): ProjectLabelOwnerSearchError {
  switch (error._tag) {
    case "GitHubCliMissingError":
    case "GitHubNotSignedInError":
    case "GitHubHostDisabledError":
    case "GitHubApiAuthenticationError":
      return new ProjectLabelOwnerSearchError({
        operation: "searchOwnerRepositories",
        reason: "github_not_connected",
        detail: error.message,
      });
    case "GitHubApiRateLimitError":
    case "SourceControlRateLimitPausedError":
      return new ProjectLabelOwnerSearchError({
        operation: "searchOwnerRepositories",
        reason: "github_rate_limited",
        detail: error.message,
      });
    case "GitHubCliFailedError":
    case "GitHubApiRequestError":
    case "GitHubApiResponseError":
    case "GitHubApiNotFoundError":
      return new ProjectLabelOwnerSearchError({
        operation: "searchOwnerRepositories",
        reason: "github_unavailable",
        detail: error.message,
      });
  }
}

export interface ProjectOwnerRepositorySearchDeps {
  readonly labels: Pick<ProjectLabelService.ProjectLabelService["Service"], "read">;
  readonly github: Pick<GitHubRest.GitHubRest["Service"], "rest">;
  readonly projects: Pick<ProjectStore.ProjectStoreV2["Service"], "list">;
  readonly identities: Pick<
    RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
    "resolve"
  >;
}

/**
 * The linked owners' GitHub repositories matching `query` (or, with no owner
 * linked, the signed-in account's), most recently pushed first. Reads the first page per owner through the server's GitHub
 * credential, so private organization repositories the user can access are
 * included. A linked owner that is a user rather than an organization reads
 * through the user endpoint instead.
 */
export const searchLabelOwnerRepositories = Effect.fn("ProjectOwnerRepositorySearch.search")(
  function* (
    input: ProjectLabelOwnerRepositorySearchInput,
    deps: ProjectOwnerRepositorySearchDeps,
  ) {
    const { label } = yield* deps.labels.read(input.id);
    const owners = [
      ...new Set(
        label.sourceLinks.flatMap((link) => (link.kind === "github-owner" ? [link.owner] : [])),
      ),
    ];
    const limit = input.limit ?? PROJECT_LABEL_OWNER_SEARCH_DEFAULT_LIMIT;

    const rows = yield* deps.projects.list().pipe(
      Effect.mapError(
        (cause) =>
          new ProjectLabelError({
            operation: "searchOwnerRepositories",
            reason: "storage",
            cause,
          }),
      ),
    );
    const local = new Set<string>();
    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.map(deps.identities.resolve(row.workspaceRoot), (identity) => {
          if (identity?.owner && identity.name) {
            local.add(localRepositoryKey(identity.owner, identity.name));
          }
        }),
      { concurrency: 8, discard: true },
    );

    const fetchOwner = (owner: string) =>
      Effect.gen(function* () {
        const encoded = encodeURIComponent(owner);
        const base = `per_page=${OWNER_REPOSITORIES_PER_PAGE}&type=all&sort=pushed&direction=desc`;
        // An owner that is a user rather than an organization 404s on the org
        // endpoint and reads through the user endpoint instead.
        const orgResponse = yield* deps.github
          .rest({
            host: "github.com",
            operation: "ProjectOwnerRepositorySearch.listOwnerRepositories",
            path: `orgs/${encoded}/repos?${base}`,
            timeout: OWNER_REPOSITORIES_TIMEOUT,
          })
          .pipe(
            Effect.catchTags({
              GitHubApiNotFoundError: () => Effect.succeed(null),
            }),
          );
        const response =
          orgResponse ??
          (yield* deps.github
            .rest({
              host: "github.com",
              operation: "ProjectOwnerRepositorySearch.listUserRepositories",
              path: `users/${encoded}/repos?${base}`,
              timeout: OWNER_REPOSITORIES_TIMEOUT,
            })
            .pipe(
              Effect.catchTags({
                GitHubApiNotFoundError: () => Effect.succeed(null),
              }),
            ));
        if (response === null) return [];
        return (Option.getOrUndefined(decodeRepositoryListJson(response.body)) ?? []).flatMap(
          (value) => Option.toArray(decodeRepositoryRow(value)),
        );
      }).pipe(Effect.mapError(toSearchError));

    // A project that links no owner lists the signed-in account's own
    // repositories (and those of its organizations) instead.
    const fetchSignedInAccount = Effect.gen(function* () {
      const response = yield* deps.github.rest({
        host: "github.com",
        operation: "ProjectOwnerRepositorySearch.listAccountRepositories",
        path: `user/repos?per_page=${OWNER_REPOSITORIES_PER_PAGE}&affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc`,
        timeout: OWNER_REPOSITORIES_TIMEOUT,
      });
      return (Option.getOrUndefined(decodeRepositoryListJson(response.body)) ?? []).flatMap(
        (value) => Option.toArray(decodeRepositoryRow(value)),
      );
    }).pipe(Effect.mapError(toSearchError));

    const pages =
      owners.length === 0
        ? [yield* fetchSignedInAccount]
        : yield* Effect.forEach(owners, fetchOwner, { concurrency: 4 });
    const seen = new Set<string>();
    const repositories: Array<ProjectLabelOwnerRepository> = [];
    for (const row of pages.flat()) {
      const key = localRepositoryKey(row.owner.login, row.name);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!matchesOwnerRepositoryQuery(row.name, input.query)) continue;
      const mapped = mapGitHubOwnerRepositoryRow(row, local.has(key));
      if (mapped) repositories.push(mapped);
      if (repositories.length >= limit) break;
    }
    return { repositories };
  },
);

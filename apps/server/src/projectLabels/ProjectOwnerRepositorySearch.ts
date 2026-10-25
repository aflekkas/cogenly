import {
  PROJECT_LABEL_OWNER_SEARCH_DEFAULT_LIMIT,
  ProjectLabelError,
  ProjectLabelOwnerRepository,
  type ProjectLabelOwnerRepositorySearchInput,
  ProjectLabelOwnerSearchError,
  type RepositoryIdentity,
} from "@cogenly/contracts";
import * as GitHubRest from "@cogenly/source-control-github/server/GitHubRest";
import * as GitHubRequestPolicy from "@cogenly/source-control-github/server/GitHubRequestPolicy";
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

const GITHUB_KEY_PREFIX = "github.com/";

function gitHubKeyOf(canonicalKey: string | undefined): string | null {
  if (!canonicalKey?.startsWith(GITHUB_KEY_PREFIX)) return null;
  const [owner, name, ...rest] = canonicalKey.slice(GITHUB_KEY_PREFIX.length).split("/");
  return owner && name && rest.length === 0 ? localRepositoryKey(owner, name) : null;
}

/**
 * Every GitHub `owner/name` a checkout answers to, lowercase: its canonical
 * remote, a fork's own remote, and any other remote on GitHub. A checkout
 * whose origin is another host (a GitHub Enterprise mirror, say) still
 * answers to the GitHub repository a second remote points at.
 */
export function localGitHubRepositoryKeys(
  identity: RepositoryIdentity | null | undefined,
): ReadonlyArray<string> {
  if (!identity) return [];
  const keys = [
    gitHubKeyOf(identity.canonicalKey),
    gitHubKeyOf(identity.origin?.canonicalKey),
    ...(identity.remoteKeys ?? []).map(gitHubKeyOf),
  ];
  return [...new Set(keys.filter((key) => key !== null))];
}

/** At most this many renamed-owner lookups per search, so a search stays one round trip or two. */
const RENAME_LOOKUP_LIMIT = 4;
const RENAME_LOOKUP_TIMEOUT = "4 seconds";

const GitHubRepositoryFullName = Schema.fromJsonString(Schema.Struct({ full_name: Schema.String }));
const decodeRepositoryFullName = Schema.decodeUnknownOption(GitHubRepositoryFullName);

/**
 * Local keys that may name one of `candidates` under an owner's old name:
 * same repository name, different owner. GitHub redirects a renamed owner's
 * repositories, so a checkout's remote can keep the old owner for good.
 */
export function renameLookupCandidates(
  local: ReadonlySet<string>,
  candidates: ReadonlyArray<string>,
): string[] {
  const wanted = new Set(candidates);
  const names = new Set(candidates.map((key) => key.slice(key.indexOf("/") + 1)));
  return [...local]
    .filter((key) => !wanted.has(key) && names.has(key.slice(key.indexOf("/") + 1)))
    .slice(0, RENAME_LOOKUP_LIMIT);
}

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
          for (const key of localGitHubRepositoryKeys(identity)) local.add(key);
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
    const matched: Array<GitHubOwnerRepositoryRow> = [];
    for (const row of pages.flat()) {
      const key = localRepositoryKey(row.owner.login, row.name);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!matchesOwnerRepositoryQuery(row.name, input.query)) continue;
      matched.push(row);
      if (matched.length >= limit) break;
    }

    // A checkout whose remote still names an owner's old login answers to the
    // renamed repository: ask GitHub where the old address leads. Best effort;
    // a failed lookup leaves the row as it was.
    const unmatched = matched
      .map((row) => localRepositoryKey(row.owner.login, row.name))
      .filter((key) => !local.has(key));
    yield* Effect.forEach(
      renameLookupCandidates(local, unmatched),
      (key) =>
        deps.github
          .rest({
            host: "github.com",
            operation: "ProjectOwnerRepositorySearch.resolveRenamedRepository",
            path: `repos/${key.split("/").map(encodeURIComponent).join("/")}`,
            timeout: RENAME_LOOKUP_TIMEOUT,
          })
          .pipe(
            Effect.map((response) => {
              const resolved = Option.getOrUndefined(decodeRepositoryFullName(response.body));
              if (resolved) {
                const [owner = "", name = ""] = resolved.full_name.split("/");
                if (owner && name) local.add(localRepositoryKey(owner, name));
              }
            }),
            Effect.ignore,
          ),
      { concurrency: RENAME_LOOKUP_LIMIT, discard: true },
    );

    const repositories: Array<ProjectLabelOwnerRepository> = [];
    for (const row of matched) {
      const key = localRepositoryKey(row.owner.login, row.name);
      const mapped = mapGitHubOwnerRepositoryRow(row, local.has(key));
      if (mapped) repositories.push(mapped);
    }
    return { repositories };
  },
);

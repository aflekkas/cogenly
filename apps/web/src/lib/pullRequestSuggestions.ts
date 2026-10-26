import {
  EnvironmentId,
  PullRequestListEntry,
  PullRequestListProjectError,
  PullRequestListResult,
} from "@cogenly/contracts";

import type { PullRequestDiffStat, PullRequestListCursors } from "@cogenly/contracts";

/**
 * A listed change request with the environment that read it. Nothing on a row says which machine
 * it came from, and the page unions every connected one, so acting on a row, refreshing it, or
 * opening its detail all need the tag the listing itself does not carry.
 */
export interface EnvironmentPullRequestEntry extends PullRequestListEntry {
  readonly environmentId: EnvironmentId;
}

export interface EnvironmentPullRequestStat extends PullRequestDiffStat {
  readonly environmentId: EnvironmentId;
}

export interface EnvironmentPullRequestError extends PullRequestListProjectError {
  readonly environmentId: EnvironmentId;
}

/**
 * The signed-in account per host. Keyed `"<environmentId> <host>"` once a listing spans more than
 * one environment: two machines can both reach github.com signed in as different people, and a
 * single host-keyed record would let whichever answered last decide who "I" am, which is how
 * every row of somebody's own work came to be filed under Others.
 */
export type PullRequestViewers = PullRequestListResult["viewers"];

/** Free-text filter over the fields a row actually shows, plus `#123` / `123`. */
export function matchesPullRequestQuery(entry: PullRequestListEntry, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return true;
  return `#${entry.number} ${entry.title} ${entry.repository} ${entry.headBranch} ${entry.author?.login ?? ""}`
    .toLowerCase()
    .includes(normalizedQuery);
}

/**
 * Every connected environment's listing, read as one list.
 *
 * `nextCursors` is keyed by environment rather than by repository: a cursor only means anything
 * to the host that issued it, and two machines can hold the same repository. `viewers` is not:
 * a host names one account, and the same host reached from two machines is the same account.
 */
export interface MergedPullRequestList {
  /** Keyed `"<environmentId> <host>"`, so one host's two accounts stay two accounts. */
  readonly viewers: PullRequestViewers;
  readonly providers: PullRequestListResult["providers"];
  readonly entries: ReadonlyArray<EnvironmentPullRequestEntry>;
  readonly errors: ReadonlyArray<EnvironmentPullRequestError>;
  readonly truncated: boolean;
  readonly nextCursors: Readonly<Record<string, PullRequestListCursors>>;
  /**
   * The environments with rows still on their hosts. Those with a cursor are continued from it;
   * the rest can only be reached by asking them for a longer page, and are named here so that
   * asking still happens once every other environment has run out of cursors.
   */
  readonly truncatedEnvironments: ReadonlyArray<string>;
}

/**
 * The environments' answers folded into one. A host reached from more than one environment is one
 * row in the switcher, readable if any environment could read it and searched on the host only if
 * every one of them did. A host answering unnarrowed anywhere still needs the local pass.
 */
export function mergePullRequestLists(
  answers: ReadonlyArray<readonly [EnvironmentId, PullRequestListResult]>,
): MergedPullRequestList | null {
  if (answers.length === 0) return null;
  const viewers: Record<string, string> = {};
  const truncatedEnvironments: string[] = [];
  const providers = new Map<string, PullRequestListResult["providers"][number]>();
  const entries: EnvironmentPullRequestEntry[] = [];
  const errors: EnvironmentPullRequestError[] = [];
  const nextCursors: Record<string, PullRequestListCursors> = {};
  let truncated = false;
  for (const [environmentId, answer] of answers) {
    for (const [host, login] of Object.entries(answer.viewers)) {
      viewers[`${environmentId} ${host}`] = login;
    }
    for (const provider of answer.providers) {
      const held = providers.get(provider.host);
      providers.set(
        provider.host,
        held === undefined
          ? provider
          : {
              ...(held.configured ? held : provider),
              projectCount: held.projectCount + provider.projectCount,
              searchesOnHost: held.searchesOnHost && provider.searchesOnHost,
              configured: held.configured || provider.configured,
            },
      );
    }
    entries.push(...answer.entries.map((entry) => ({ ...entry, environmentId })));
    errors.push(...answer.errors.map((error) => ({ ...error, environmentId })));
    truncated ||= answer.truncated;
    if (answer.truncated) truncatedEnvironments.push(environmentId);
    if (Object.keys(answer.nextCursors).length > 0) {
      nextCursors[environmentId] = answer.nextCursors;
    }
  }
  return {
    viewers,
    providers: [...providers.values()],
    entries: entries.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    errors,
    truncated,
    nextCursors,
    truncatedEnvironments,
  };
}

/**
 * How well a row answers the text that was searched for, as a number to order by.
 *
 * Every host searches more than a row shows (GitHub reads bodies and commit messages, GitLab
 * and Bitbucket read descriptions), so a result can be a real match with nothing on the row to
 * show for it. Ordering those by recency alone is what puts an apparently unrelated pull request
 * between two obvious ones. They are still results, so they are still shown; they are shown last,
 * under the rows whose own words matched.
 *
 * The scale is deliberately coarse. It sorts rows into "this is the one", "this mentions it" and
 * "the host says so", which is as fine a judgement as the row's own fields support.
 */
function scorePullRequestMatch(entry: PullRequestListEntry, query: string): number {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 0;
  const number = needle.replace(/^#/u, "");
  // Asking for a number is asking for one pull request, and it is the answer or it is not.
  if (/^\d+$/u.test(number)) return String(entry.number) === number ? 100 : 0;

  const title = entry.title.toLowerCase();
  const terms = needle.split(/\s+/u).filter((term) => term.length > 0);
  if (title === needle) return 90;
  if (title.includes(needle)) return 80;
  // Every word, in any order: "wizard welcome" is still about the welcome wizard.
  if (terms.length > 1 && terms.every((term) => title.includes(term))) return 70;
  if (entry.headBranch.toLowerCase().includes(needle)) return 60;
  if ((entry.author?.login ?? "").toLowerCase().includes(needle)) return 50;
  if (entry.repository.toLowerCase().includes(needle)) return 40;
  if (terms.some((term) => title.includes(term))) return 30;
  // The host matched something this row does not show: a description, a comment, a commit.
  return 10;
}

/**
 * Search results in the order they answer the question, most convincing first, and by recency
 * among equals. Without a search, preserve the host order for the caller's browse-time ranking.
 */
export function rankPullRequestMatches<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  query: string,
): ReadonlyArray<Entry> {
  if (query.trim().length === 0) return entries;
  return entries.toSorted((left, right) => {
    const byScore = scorePullRequestMatch(right, query) - scorePullRequestMatch(left, query);
    return byScore !== 0 ? byScore : right.updatedAt.localeCompare(left.updatedAt);
  });
}

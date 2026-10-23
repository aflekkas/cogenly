/**
 * How the repository pickers tell a project's repositories apart from its
 * GitHub results: each repository shows once (a local clone wins and names
 * its GitHub repository), and a clone that did not land reads as one
 * actionable sentence.
 */
import type { ProjectLabelOwnerRepository, RepositoryIdentity } from "@t3tools/contracts";

const GITHUB_PREFIX = "github.com/";

function gitHubPathOf(canonicalKey: string | undefined): string | null {
  if (!canonicalKey?.startsWith(GITHUB_PREFIX)) return null;
  const [owner, name, ...rest] = canonicalKey.slice(GITHUB_PREFIX.length).split("/");
  return owner && name && rest.length === 0 ? `${owner}/${name}` : null;
}

/**
 * Every GitHub `owner/name` a checkout answers to, lowercase: the canonical
 * remote, a fork's own remote, and any other remote on GitHub (a checkout
 * whose origin is another host can still push to GitHub through a second one).
 */
export function gitHubRepositoryKeys(
  identity: RepositoryIdentity | null | undefined,
): ReadonlyArray<string> {
  if (!identity) return [];
  const keys = [
    gitHubPathOf(identity.canonicalKey),
    gitHubPathOf(identity.origin?.canonicalKey),
    ...(identity.remoteKeys ?? []).map(gitHubPathOf),
  ];
  return [...new Set(keys.filter((key) => key !== null))];
}

/**
 * The GitHub repository a checkout's row names, as `owner/name`: its own
 * remote (a fork's), else the canonical one, else any other remote on
 * GitHub. Null when none is on GitHub.
 */
export function gitHubRepositoryOf(identity: RepositoryIdentity | null | undefined): string | null {
  if (!identity) return null;
  return (
    gitHubPathOf(identity.origin?.canonicalKey) ??
    gitHubPathOf(identity.canonicalKey) ??
    gitHubRepositoryKeys(identity)[0] ??
    null
  );
}

/** The repository name of an `owner/name` key. */
function nameOfKey(key: string): string {
  return key.slice(key.indexOf("/") + 1);
}

/**
 * The label a GitHub result shows: its bare name, or `owner/name` when the
 * bare name could be mistaken for another repository — a local checkout
 * answering to a same-named repository under another owner, or another
 * result with the same name.
 */
function remoteRowLabel(
  repository: ProjectLabelOwnerRepository,
  context: {
    readonly localKeys: ReadonlyArray<string>;
    readonly remoteNames: ReadonlyMap<string, number>;
  },
): string {
  const name = repository.name.toLowerCase();
  const collides =
    (context.remoteNames.get(name) ?? 0) > 1 ||
    context.localKeys.some((key) => nameOfKey(key) === name);
  return collides ? repository.nameWithOwner : repository.name;
}

/** How many GitHub results share each lowercase name, for `remoteRowLabel`. */
function remoteNameCounts(
  repositories: ReadonlyArray<ProjectLabelOwnerRepository>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const repository of repositories) {
    const name = repository.name.toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/** Results the GitHub section shows before "Show more"; a search shows them all. */
export const REMOTE_ROWS_PREVIEW_LIMIT = 6;

/** A GitHub result as a picker lists it, with the label `remoteRowLabel` gives it. */
export interface RemoteSectionRow {
  readonly repository: ProjectLabelOwnerRepository;
  readonly label: string;
}

/**
 * The GitHub section's rows: results the project does not hold yet, each
 * labelled so it cannot be mistaken for a local checkout or another result,
 * cut to a short preview unless the user is searching or asked for more.
 * `hidden` counts what the preview leaves out, for a "Show more" row.
 */
export function remoteSectionRows(input: {
  readonly repositories: ReadonlyArray<ProjectLabelOwnerRepository>;
  readonly local: ReadonlyArray<RepositoryIdentity | null | undefined>;
  readonly searching: boolean;
  readonly expanded: boolean;
}): { readonly rows: RemoteSectionRow[]; readonly hidden: number } {
  const outside = remoteRowsOutsideProject(input.repositories, input.local);
  const context = {
    localKeys: input.local.flatMap(gitHubRepositoryKeys),
    remoteNames: remoteNameCounts(outside),
  };
  const shown =
    input.searching || input.expanded ? outside : outside.slice(0, REMOTE_ROWS_PREVIEW_LIMIT);
  return {
    rows: shown.map((repository) => ({ repository, label: remoteRowLabel(repository, context) })),
    hidden: outside.length - shown.length,
  };
}

/** A machine's run of a project's repositories, for one section per machine. */
export interface MachineSection<Item, Id extends string = string> {
  readonly environmentId: Id;
  readonly items: ReadonlyArray<Item>;
}

/**
 * Splits a project's repositories by the machine that holds them, the
 * primary machine first, then the others in first-seen order. Each
 * repository goes under its own checkout's machine, never another's.
 */
export function groupRepositoriesByMachine<Item, Id extends string>(
  items: ReadonlyArray<Item>,
  environmentOf: (item: Item) => Id,
  primaryEnvironmentId: Id | null,
): MachineSection<Item, Id>[] {
  const byEnvironment = new Map<Id, Item[]>();
  for (const item of items) {
    const environmentId = environmentOf(item);
    const run = byEnvironment.get(environmentId);
    if (run) run.push(item);
    else byEnvironment.set(environmentId, [item]);
  }
  const sections = [...byEnvironment.entries()].map(([environmentId, run]) => ({
    environmentId,
    items: run,
  }));
  return sections.toSorted(
    (left, right) =>
      Number(right.environmentId === primaryEnvironmentId) -
      Number(left.environmentId === primaryEnvironmentId),
  );
}

/**
 * GitHub results the project does not hold yet. The server already leaves
 * out repositories cloned anywhere on the machine; this also drops ones the
 * project's own checkouts answer to (a clone on another machine, or a fork's
 * own remote), and a repository two owners both return.
 */
export function remoteRowsOutsideProject(
  repositories: ReadonlyArray<ProjectLabelOwnerRepository>,
  local: ReadonlyArray<RepositoryIdentity | null | undefined>,
): ProjectLabelOwnerRepository[] {
  const held = new Set(local.flatMap(gitHubRepositoryKeys));
  const rows: ProjectLabelOwnerRepository[] = [];
  for (const repository of repositories) {
    const key = repository.nameWithOwner.toLowerCase();
    if (repository.alreadyLocal || held.has(key)) continue;
    held.add(key);
    rows.push(repository);
  }
  return rows;
}

const SERVER_ERROR_PREFIX = /^Source control repository operation \S+ failed for \S+:\s*/;

/** A clone failure as the picker shows it: what to do first, then git's own words. */
export interface CloneFailureText {
  readonly summary: string;
  /** The underlying message, when it says more than the summary. */
  readonly detail: string | null;
}

/**
 * Turns a clone error into one readable first sentence. Known git and
 * server failures get advice; anything else leads with its own first line.
 */
export function describeCloneFailure(message: string, repository: string): CloneFailureText {
  const detail = message.replace(SERVER_ERROR_PREFIX, "").trim();
  const summary = (() => {
    if (/already exists and is not (?:empty|a directory)/i.test(detail)) {
      return `A folder named ${repository} is already in this project's folder. Move or rename it, then retry.`;
    }
    // Before "not found": an SSH key failure also says it could not read from the remote.
    if (
      /permission denied|authentication failed|could not read username|publickey|403/i.test(detail)
    ) {
      return `This machine isn't signed in to GitHub with access to ${repository}.`;
    }
    if (/not found|could not read from remote/i.test(detail)) {
      return `GitHub couldn't find ${repository}, or this machine's GitHub account can't access it.`;
    }
    if (/could not resolve host|timed out|network|connection (?:refused|reset)/i.test(detail)) {
      return "Couldn't reach GitHub. Check the connection, then retry.";
    }
    const firstLine = detail
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim();
    return firstLine && firstLine.length > 0 ? firstLine : "The clone failed.";
  })();
  return { summary, detail: detail.length > 0 && detail !== summary ? detail : null };
}

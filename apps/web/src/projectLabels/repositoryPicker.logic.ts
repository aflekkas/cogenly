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
 * remote and, for a fork that tracks its upstream, its own remote too.
 */
export function gitHubRepositoryKeys(
  identity: RepositoryIdentity | null | undefined,
): ReadonlyArray<string> {
  if (!identity) return [];
  const keys = [gitHubPathOf(identity.canonicalKey), gitHubPathOf(identity.origin?.canonicalKey)];
  return [...new Set(keys.filter((key) => key !== null))];
}

/**
 * The GitHub repository a checkout's row names, as `owner/name`: its own
 * remote (a fork's), else the canonical one. Null off GitHub.
 */
export function gitHubRepositoryOf(identity: RepositoryIdentity | null | undefined): string | null {
  if (!identity) return null;
  return gitHubPathOf(identity.origin?.canonicalKey) ?? gitHubPathOf(identity.canonicalKey);
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

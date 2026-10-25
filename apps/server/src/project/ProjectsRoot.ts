import { PROJECT_REPOSITORIES_SEGMENT } from "@cogenly/contracts";
import type * as Path from "effect/Path";

import { UNFILED_REPOSITORIES_SEGMENT, sanitizePathSegment } from "@cogenly/shared/path";
import { expandHomePath } from "@cogenly/provider-core/server/pathExpansion";

export { UNFILED_REPOSITORIES_SEGMENT, sanitizePathSegment };

/**
 * The user-visible home for repositories Cogenly creates. Blank resolves to
 * `<cogenlyHome>/projects`, so dev servers land in their own home's
 * `projects/`; `~` expands to `home`; anything else resolves as an absolute
 * path, or against `home` when relative.
 */
export function resolveProjectsRootDirectory(
  setting: string,
  home: string,
  cogenlyHome: string,
  path: Path.Path,
): string {
  const trimmed = setting.trim();
  if (trimmed === "") return path.join(path.resolve(cogenlyHome), "projects");
  const expanded = expandHomePath(trimmed, home);
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(home, expanded));
}

/**
 * Where a project's linked repository lives on every machine:
 * `<project folder>/repos/<directoryName>`, where `directoryName` is `<repo>`
 * or `<owner>/<repo>` (see `repositoryDirectoryNameFor`).
 */
export function projectRepositoryDirectory(
  projectDir: string,
  directoryName: string,
  path: Path.Path,
): string {
  return path.join(
    projectDir,
    PROJECT_REPOSITORIES_SEGMENT,
    ...directoryName
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => sanitizePathSegment(segment, "repository")),
  );
}

/**
 * Where a repository lives under the projects root: `<root>/<Project>/<repo>`
 * for a project member, `<root>/Repositories/<repo>` otherwise. Existing
 * repositories never move; only new clones and repositories resolve here.
 */
export function resolveRepositoryDirectory(
  projectsRoot: string,
  projectName: string | null,
  repositoryName: string,
  path: Path.Path,
): string {
  if (projectName === null) {
    return path.join(
      projectsRoot,
      UNFILED_REPOSITORIES_SEGMENT,
      sanitizePathSegment(repositoryName, "repository"),
    );
  }
  return path.join(
    projectsRoot,
    sanitizePathSegment(projectName, "project"),
    sanitizePathSegment(repositoryName, "repository"),
  );
}

/**
 * Folder name `git clone` would pick, from either a looked-up repository or a
 * pasted clone URL. Providers report `owner/repo`, Azure DevOps reports
 * `org/project/repo`, and a URL can arrive in any form: `https://host/owner/
 * repo.git`, `ssh://git@host:22/owner/repo`, `git@host:owner/repo.git`, with
 * or without a query, a fragment or a trailing slash. The repository is always
 * the last segment, minus the `.git` suffix. Empty when nothing names one.
 * Mirrors the client's `getCloneDirectoryName`.
 */
export function repositoryDirectoryNameFromRemote(input: {
  readonly repository?: string | undefined;
  readonly remoteUrl?: string | undefined;
}): string {
  const withoutQuery = (input.repository ?? input.remoteUrl ?? "").split(/[?#]/)[0]?.trim() ?? "";
  const schemeIndex = withoutQuery.indexOf("://");
  // A remote URL carries a host before the repository path. The host is never
  // the repository, so a link that stops at the host, or at a port, names
  // nothing and the destination falls back to the browsed folder.
  const hasHost = schemeIndex >= 0 || /^[^/\\:]+@[^/\\:]+:/.test(withoutQuery);
  const pathPart = schemeIndex >= 0 ? withoutQuery.slice(schemeIndex + "://".length) : withoutQuery;
  const segments = pathPart.split(/[/\\:]+/).filter((segment) => segment.trim().length > 0);
  if (hasHost && segments.length < 2) {
    return "";
  }

  const lastSegment = segments.at(-1)?.trim() ?? "";
  // A port can only sit directly behind the authority, so it is a port only
  // when nothing follows it. Deeper segments are path, even when numeric: the
  // repository in `https://host/acme/123` really is named `123`.
  if (hasHost && segments.length === 2 && /^\d+$/.test(lastSegment)) {
    return "";
  }
  return lastSegment.endsWith(".git") ? lastSegment.slice(0, -".git".length) : lastSegment;
}

/** Default clone destination under the projects root; null when no repository name is known. */
export function resolveDefaultCloneDestination(input: {
  readonly projectsRootSetting: string;
  readonly home: string;
  readonly cogenlyHome: string;
  readonly repository?: string | undefined;
  readonly remoteUrl?: string | undefined;
  readonly path: Path.Path;
}): string | null {
  const name = repositoryDirectoryNameFromRemote(input);
  if (name === "") return null;
  return resolveRepositoryDirectory(
    resolveProjectsRootDirectory(
      input.projectsRootSetting,
      input.home,
      input.cogenlyHome,
      input.path,
    ),
    null,
    name,
    input.path,
  );
}

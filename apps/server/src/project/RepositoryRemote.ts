import { normalizeGitRemoteUrl } from "@t3tools/shared/git";

/**
 * The portable identity of a repository: its remote normalized to
 * `host/owner/repo` (lowercase host, ssh and https spellings unified, no
 * `.git` suffix, no port or credentials). Null for a repository with no
 * remote — a local-only repository — and for values that are not remotes at
 * all (filesystem paths, bare names).
 */
export function normalizeRepositoryRemote(remoteUrl: string | null | undefined): string | null {
  if (remoteUrl === null || remoteUrl === undefined) return null;
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) return null;
  const isRemote =
    /^(?:ssh|https?|git):\/\//i.test(trimmed) || /^[^\s/@:]+@[^\s/:]+:[^\s]+$/.test(trimmed);
  if (!isRemote) return null;
  const normalized = normalizeGitRemoteUrl(trimmed);
  const [host, ...rest] = normalized.split("/");
  if (host === undefined || host.length === 0 || rest.length === 0) return null;
  if (rest.some((segment) => segment.length === 0)) return null;
  return normalized;
}

/** The directory name a repository lives in, from its workspace root. */
export function repositoryDirectoryName(workspaceRoot: string): string | null {
  const segments = workspaceRoot
    .replace(/[\\/]+$/, "")
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);
  return segments.at(-1) ?? null;
}

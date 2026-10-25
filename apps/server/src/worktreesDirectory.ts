import type * as Path from "effect/Path";

import { expandHomePath } from "@cogenly/provider-core/server/pathExpansion";

/**
 * Directory new worktrees are created under: the `worktreesDirectory`
 * setting (`~` expands to `home`), or `defaultDir` (`<Cogenly home>/worktrees`)
 * when it is empty. Null when
 * the setting is not an absolute path on this machine, such as `D:\worktrees`
 * configured for a Windows server and synced to a Linux one, or when it is a
 * filesystem root, which would make every path on that drive look managed.
 */
export function resolveWorktreesDirectory(
  setting: string,
  defaultDir: string,
  path: Path.Path,
  home: string,
): string | null {
  if (setting === "") return defaultDir;
  const expanded = expandHomePath(setting, home);
  if (!path.isAbsolute(expanded)) return null;
  const resolved = path.resolve(expanded);
  return isFilesystemRoot(resolved, path) ? null : resolved;
}

/**
 * The hidden folder inside a project that holds its worktrees, mirroring
 * `repos/`: `.worktrees/<repo>/<slug>`, or `.worktrees/<owner>/<repo>/<slug>`
 * for another owner's repository.
 */
export const WORKTREES_SEGMENT = ".worktrees";
/**
 * Where project worktrees were created before `.worktrees/`. Nothing new
 * lands there, but worktrees already in it keep working, so every scan that
 * skips or finds managed worktrees treats it like `.worktrees/`.
 */
export const LEGACY_WORKTREES_SEGMENT = "worktrees";
/** Both worktree containers a project folder can hold. */
export const isWorktreesSegment = (segment: string): boolean =>
  segment === WORKTREES_SEGMENT || segment === LEGACY_WORKTREES_SEGMENT;

/**
 * The parent new worktrees are created under, before the `<repo>/<slug>`
 * tail: an explicit `worktreesDirectory` setting wins, then the project's
 * `.worktrees/` for a repository that belongs to a project (plus its owner
 * folder when the repository sits under `repos/<owner>/`), then `defaultDir`
 * (`<Cogenly home>/worktrees`) for repositories in no project. Null when an
 * explicit setting is not an absolute path on this machine, mirroring
 * {@link resolveWorktreesDirectory}.
 */
export function resolveWorktreeParentDirectory(input: {
  readonly setting: string;
  readonly defaultDir: string;
  readonly projectDir: string | null;
  /** The repository's `directoryName` in its project: `<repo>` or `<owner>/<repo>`. */
  readonly repositoryDirectoryName?: string | null | undefined;
  readonly path: Path.Path;
  readonly home: string;
}): string | null {
  if (input.setting !== "") {
    return resolveWorktreesDirectory(input.setting, input.defaultDir, input.path, input.home);
  }
  if (input.projectDir !== null) {
    const owner = input.repositoryDirectoryName?.split("/").slice(0, -1) ?? [];
    return input.path.join(input.path.resolve(input.projectDir), WORKTREES_SEGMENT, ...owner);
  }
  return input.defaultDir;
}

/**
 * The worktree roots of every folder directly inside the projects root: its
 * `.worktrees/` and the legacy `worktrees/`.
 */
export function projectWorktreesDirectories(
  projectsRoot: string,
  entryNames: ReadonlyArray<string>,
  path: Path.Path,
): ReadonlyArray<string> {
  return entryNames.flatMap((entry) =>
    [WORKTREES_SEGMENT, LEGACY_WORKTREES_SEGMENT].map((segment) =>
      path.join(path.resolve(projectsRoot), entry, segment),
    ),
  );
}

/** Callers re-check after resolving symlinks: a link can point at a root. */
export function isFilesystemRoot(directory: string, path: Path.Path): boolean {
  return path.dirname(directory) === directory;
}

/**
 * Every directory that holds T3-managed worktrees on this machine: the
 * default and configured directories, plus any project-local roots the
 * caller resolved (see {@link projectWorktreesDirectories}).
 */
export function managedWorktreesDirectories(
  settings: {
    readonly worktreesDirectory: string;
    readonly previousWorktreesDirectories: ReadonlyArray<string>;
  },
  defaultDir: string,
  path: Path.Path,
  home: string,
  projectWorktreeRoots: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  const directories = new Set([defaultDir, ...projectWorktreeRoots]);
  for (const setting of [settings.worktreesDirectory, ...settings.previousWorktreesDirectories]) {
    const directory = resolveWorktreesDirectory(setting, defaultDir, path, home);
    if (directory !== null) directories.add(directory);
  }
  return [...directories];
}

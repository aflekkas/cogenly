import type * as Path from "effect/Path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

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

/** The reserved folder inside a project (or `Repositories/`) that holds its worktrees. */
export const WORKTREES_SEGMENT = "worktrees";

const isWithinDirectory = (candidate: string, directory: string, path: Path.Path): boolean => {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * The parent new worktrees are created under, before the
 * `<repo>/<slug>` tail: an explicit `worktreesDirectory` setting wins, then
 * the project folder of a repository that belongs to a project, then the
 * folder containing a repository under the projects root (for example
 * `Repositories/`), then `defaultDir`. Null when an explicit setting is not
 * an absolute path on this machine, mirroring {@link resolveWorktreesDirectory}.
 */
export function resolveWorktreeParentDirectory(input: {
  readonly setting: string;
  readonly defaultDir: string;
  readonly repoCwd: string;
  readonly projectDir: string | null;
  readonly projectsRoot: string | null;
  readonly path: Path.Path;
  readonly home: string;
}): string | null {
  if (input.setting !== "") {
    return resolveWorktreesDirectory(input.setting, input.defaultDir, input.path, input.home);
  }
  if (input.projectDir !== null) {
    return input.path.join(input.path.resolve(input.projectDir), WORKTREES_SEGMENT);
  }
  if (input.projectsRoot !== null) {
    const containingDir = input.path.dirname(input.path.resolve(input.repoCwd));
    if (isWithinDirectory(containingDir, input.projectsRoot, input.path)) {
      return input.path.join(containingDir, WORKTREES_SEGMENT);
    }
  }
  return input.defaultDir;
}

/** The `<entry>/worktrees` root of every folder directly inside the projects root. */
export function projectWorktreesDirectories(
  projectsRoot: string,
  entryNames: ReadonlyArray<string>,
  path: Path.Path,
): ReadonlyArray<string> {
  return entryNames.map((entry) => path.join(path.resolve(projectsRoot), entry, WORKTREES_SEGMENT));
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

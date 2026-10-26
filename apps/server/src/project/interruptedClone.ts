import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

/**
 * Whether `root` holds a clone git started but never finished: its own `.git`
 * directory and nothing else, with no index and no branch. git writes the
 * branches when the fetch completes and the index when it checks the files
 * out, so a finished clone, and any checkout someone has committed or staged
 * in, has them. The server stopping mid-clone leaves this behind; it holds
 * only what the clone fetched, so the launch paths clear it and clone again
 * rather than run in an empty repository.
 */
export const isInterruptedClone = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const entries = yield* fileSystem.readDirectory(root);
    if (entries.length !== 1 || entries[0] !== ".git") return false;
    const gitDir = path.join(root, ".git");
    if ((yield* fileSystem.stat(gitDir)).type !== "Directory") return false;
    if (yield* fileSystem.exists(path.join(gitDir, "index"))) return false;
    if (yield* fileSystem.exists(path.join(gitDir, "packed-refs"))) return false;
    const branches = yield* fileSystem
      .readDirectory(path.join(gitDir, "refs", "heads"))
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    return branches.length === 0;
  }).pipe(Effect.orElseSucceed(() => false));

/** Empties an interrupted clone's folder (keeping the folder); true when there was one. */
export const clearInterruptedClone = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
) =>
  isInterruptedClone(fileSystem, path, root).pipe(
    Effect.flatMap((interrupted) =>
      interrupted
        ? fileSystem.remove(path.join(root, ".git"), { recursive: true }).pipe(Effect.as(true))
        : Effect.succeed(false),
    ),
  );

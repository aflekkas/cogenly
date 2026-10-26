// @effect-diagnostics nodeBuiltinImport:off - rmdir (refuses a non-empty folder) and the platform Trash have no Effect FileSystem equivalent.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as HostProcess from "@cogenly/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class FolderTrashError extends Schema.TaggedError<FolderTrashError>()("FolderTrashError", {
  path: Schema.String,
  reason: Schema.Literals(["unavailable", "failed"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason === "unavailable"
      ? "This machine has no Trash Cogenly can use. Open the folder and delete it yourself."
      : "Could not move the folder to the Trash.";
  }
}

const MACOS_TRASH = "/usr/bin/trash";

const execFile = (command: string, args: ReadonlyArray<string>) =>
  new Promise<void>((resolve, reject) =>
    NodeChildProcess.execFile(command, [...args], { timeout: 30_000 }, (error) =>
      error ? reject(error) : resolve(),
    ),
  );

const exists = (target: string) =>
  NodeFSP.lstat(target).then(
    () => true,
    () => false,
  );

// freedesktop.org Trash: the entry goes to `files/`, where to restore it to
// in `info/<name>.trashinfo`. The info file is written first and exclusively,
// so the name is ours before anything moves.
async function moveToFreedesktopTrash(
  target: string,
  dataHome: string,
  deletedAt: string,
): Promise<void> {
  const trash = NodePath.join(dataHome, "Trash");
  await NodeFSP.mkdir(NodePath.join(trash, "files"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(trash, "info"), { recursive: true });
  const base = NodePath.basename(target);
  for (let attempt = 1; attempt <= 100; attempt++) {
    const name = attempt === 1 ? base : `${base}.${attempt}`;
    const info = NodePath.join(trash, "info", `${name}.trashinfo`);
    const restorePath = encodeURI(target).replaceAll("#", "%23").replaceAll("?", "%3F");
    try {
      await NodeFSP.writeFile(
        info,
        `[Trash Info]\nPath=${restorePath}\nDeletionDate=${deletedAt}\n`,
        { flag: "wx" },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    const destination = NodePath.join(trash, "files", name);
    if (await exists(destination)) {
      await NodeFSP.rm(info, { force: true });
      continue;
    }
    try {
      // A rename never copies, so a Trash on another disk fails instead of half-moving.
      await NodeFSP.rename(target, destination);
      return;
    } catch (error) {
      await NodeFSP.rm(info, { force: true });
      throw error;
    }
  }
  throw new Error("Every Trash name for the folder is taken.");
}

/**
 * Moves a folder to this machine's Trash so it can be put back: Finder's
 * Trash on macOS 15+ (`/usr/bin/trash`), the freedesktop Trash on Linux.
 * Anywhere else it fails as `unavailable` and nothing moves. Tests replace
 * it so they never touch the developer's Trash.
 */
export class FolderTrash extends Context.Reference<{
  readonly moveToTrash: (target: string) => Effect.Effect<void, FolderTrashError>;
}>("cogenly-server/projectLabels/FolderTrash", {
  defaultValue: () => ({
    moveToTrash: (target) =>
      Effect.gen(function* () {
        const failed = (cause: unknown) =>
          new FolderTrashError({ path: target, reason: "failed", cause });
        const platform = yield* HostProcess.Platform;
        if (platform === "darwin") {
          if (!(yield* Effect.promise(() => exists(MACOS_TRASH))))
            return yield* new FolderTrashError({ path: target, reason: "unavailable" });
          yield* Effect.tryPromise({ try: () => execFile(MACOS_TRASH, [target]), catch: failed });
          // `trash` exits 0 even when an item could not move.
          if (yield* Effect.promise(() => exists(target)))
            return yield* failed("The folder is still in place.");
          return;
        }
        if (platform === "linux") {
          const env = yield* HostProcess.Environment;
          const dataHome =
            env.XDG_DATA_HOME || NodePath.join(yield* HostProcess.HomeDirectory, ".local/share");
          // The spec's DeletionDate: local time, to the second, no zone.
          const now = DateTime.setZone(yield* DateTime.now, DateTime.zoneMakeLocal());
          const deletedAt = DateTime.formatIsoOffset(now).slice(0, 19);
          yield* Effect.tryPromise({
            try: () => moveToFreedesktopTrash(target, dataHome, deletedAt),
            catch: failed,
          });
          return;
        }
        return yield* new FolderTrashError({ path: target, reason: "unavailable" });
      }),
  }),
}) {}

/**
 * Removes a folder holding only the skeleton Cogenly made: `markerFile`,
 * Finder's `.DS_Store`, and the empty `skeletonDirs`. Every directory goes by
 * `rmdir`, which the OS refuses for a non-empty one, so a file that is not
 * named here, including one written while this runs, is never deleted: the
 * removal stops, the marker is put back, and it returns false.
 */
export const removeEmptySkeleton = (
  dir: string,
  markerFile: string,
  skeletonDirs: ReadonlyArray<string>,
): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    const removeFinderFile = (inside: string) =>
      NodeFSP.rm(NodePath.join(inside, ".DS_Store"), { force: true }).catch(() => undefined);
    const rmdir = (target: string) =>
      NodeFSP.rmdir(target).then(
        () => true,
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
    for (const name of skeletonDirs) {
      const sub = NodePath.join(dir, name);
      const stat = await NodeFSP.lstat(sub).catch(() => null);
      if (stat === null) continue;
      if (!stat.isDirectory()) return false;
      await removeFinderFile(sub);
      if (!(await rmdir(sub))) return false;
    }
    const marker = NodePath.join(dir, markerFile);
    const markerText = await NodeFSP.readFile(marker, "utf8").catch(() => null);
    await removeFinderFile(dir);
    if (markerText !== null) await NodeFSP.rm(marker, { force: true });
    if (await rmdir(dir)) return true;
    // Something else is in it: leave it as it was found.
    if (markerText !== null)
      await NodeFSP.writeFile(marker, markerText, { flag: "wx" }).catch(() => undefined);
    return false;
  });

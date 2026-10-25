// @effect-diagnostics nodeBuiltinImport:off - Effect has no statfs; volume accounting needs Node.
import type { StorageVolume } from "@cogenly/contracts";
import * as NodeFSP from "node:fs/promises";
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export class StorageInspectionError extends Schema.TaggedError<StorageInspectionError>()(
  "StorageInspectionError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not inspect storage at ${this.path}.`;
  }
}

export class StorageInspection extends Context.Service<
  StorageInspection,
  {
    /** Allocated blocks, with hardlinks counted once and symlinks never followed. */
    readonly measure: (
      roots: ReadonlyArray<{ path: string; category: string }>,
      classify?: (path: string, category: string) => string,
    ) => Effect.Effect<
      ReadonlyArray<{
        category: string;
        bytes: number;
        exclusiveBytes: number;
        apparentBytes: number;
        files: number;
      }>,
      StorageInspectionError
    >;
    /** An unknown process inventory blocks deletion too. */
    readonly volumes: (
      paths: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<StorageVolume>, StorageInspectionError>;
    readonly processBlocker: (cwd: string) => Effect.Effect<string | null>;
    readonly gitBlocker: (
      cwd: string,
      branch: string,
      protectIgnored?: boolean,
    ) => Effect.Effect<string | null, StorageInspectionError>;
  }
>()("cogenly-server/housekeeping/StorageInspection") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const within = (root: string, target: string) =>
    target === root || target.startsWith(`${root}${path.sep}`);
  const isLink = (target: string) =>
    fs.readLink(target).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) =>
          error.cause instanceof Error && "code" in error.cause && error.cause.code === "EINVAL",
        () => Effect.succeed(false),
      ),
    );

  const measure: StorageInspection["Service"]["measure"] = Effect.fn("StorageInspection.measure")(
    function* (roots, classify = (_, category) => category) {
      const inodes = new Map<
        string,
        {
          category: string;
          bytes: number;
          links: bigint;
          found: bigint;
          apparent: number;
          file: boolean;
        }
      >();
      const visited = new Set<string>();
      const pending = roots.map((root) => ({ ...root, path: path.resolve(root.path) }));
      while (pending.length > 0) {
        const entry = pending.pop()!;
        if (visited.has(entry.path)) continue;
        visited.add(entry.path);
        if (visited.size > 2_000_000)
          return yield* new StorageInspectionError({
            path: entry.path,
            cause: new Error("Inspection limit"),
          });
        const stat = yield* Effect.gen(function* () {
          if (yield* isLink(entry.path)) return null;
          return yield* fs.stat(entry.path);
        }).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.succeed(null),
          ),
          Effect.mapError((cause) => new StorageInspectionError({ path: entry.path, cause })),
        );
        if (stat === null) continue;
        const category = classify(entry.path, entry.category);
        const key = `${stat.dev}:${Option.getOrElse(stat.ino, () => entry.path)}`;
        const existing = inodes.get(key);
        if (existing) existing.found++;
        else
          inodes.set(key, {
            category,
            bytes: Number(Option.getOrElse(stat.blocks, () => 0n)) * 512,
            links: stat.type === "Directory" ? 1n : Option.getOrElse(stat.nlink, () => 1n),
            found: 1n,
            apparent: stat.type === "File" ? Number(stat.size) : 0,
            file: stat.type === "File",
          });
        if (stat.type === "Directory") {
          const names = yield* fs
            .readDirectory(entry.path)
            .pipe(
              Effect.mapError((cause) => new StorageInspectionError({ path: entry.path, cause })),
            );
          for (const name of names) pending.push({ path: path.join(entry.path, name), category });
        }
      }
      const totals = new Map<
        string,
        {
          category: string;
          bytes: number;
          exclusiveBytes: number;
          apparentBytes: number;
          files: number;
        }
      >();
      for (const inode of inodes.values()) {
        const total = totals.get(inode.category) ?? {
          category: inode.category,
          bytes: 0,
          exclusiveBytes: 0,
          apparentBytes: 0,
          files: 0,
        };
        total.bytes += inode.bytes;
        total.apparentBytes += inode.apparent;
        if (inode.file) total.files += Number(inode.found);
        if (inode.found >= inode.links) total.exclusiveBytes += inode.bytes;
        totals.set(inode.category, total);
      }
      return [...totals.values()];
    },
  );

  const processBlocker = Effect.fn("StorageInspection.processBlocker")(
    function* (cwd: string) {
      const root = yield* fs.realPath(cwd);
      if (platform === "linux") {
        for (const pid of (yield* fs.readDirectory("/proc")).filter((name) => /^\d+$/.test(name))) {
          const target = yield* fs.readLink(`/proc/${pid}/cwd`).pipe(
            Effect.catchIf(
              (error) => error.reason._tag === "NotFound",
              () => Effect.succeed(null),
            ),
          );
          if (target !== null && within(root, target))
            return "process has its cwd inside the worktree";
        }
        return null;
      }
      if (platform !== "darwin") return "process inspection is unavailable on this platform";
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make("/usr/sbin/lsof", ["-nP", "-d", "cwd", "-Fpn0"], { stdin: "ignore" }),
          );
          const [output, errors, exitCode] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(child.stdout)),
              Stream.mkString(Stream.decodeText(child.stderr)),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (Number(exitCode) !== 0 || errors.trim() !== "")
            return "process inventory could not be verified";
          const cwds = output
            .split("\0")
            .map((field) => field.replace(/^\n/, ""))
            .filter((field) => field.startsWith("n"))
            .map((field) => field.slice(1));
          if (cwds.length === 0) return "process inventory could not be verified";
          return cwds.some((target) => within(root, target))
            ? "process has its cwd inside the worktree"
            : null;
        }),
      );
    },
    Effect.timeout("15 seconds"),
    Effect.orElseSucceed(() => "process inventory could not be verified"),
  );

  const gitBlocker = Effect.fn("StorageInspection.gitBlocker")(
    function* (cwd: string, branch: string, protectIgnored = false) {
      const read = (args: string[]) =>
        git.execute({
          operation: "StorageInspection.gitBlocker",
          cwd,
          args,
          env: { GIT_OPTIONAL_LOCKS: "0" },
          maxOutputBytes: 256 * 1024,
        });
      const head = yield* read(["rev-parse", "HEAD"]);
      const saved = yield* read(["rev-parse", `refs/heads/${branch}`]);
      if (head.stdout.trim() !== saved.stdout.trim())
        return "commits are not preserved by the retained branch";
      const stash = yield* read(["stash", "list", "--format=%H"]);
      if (stash.stdout.trim() !== "" || stash.stdoutTruncated)
        return "repository has stashed changes";
      const status = yield* read([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]);
      if (status.stdout !== "" || status.stdoutTruncated)
        return "has unsaved changes (edited or untracked files)";
      const ignored = yield* read([
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ]);
      if (ignored.stdoutTruncated) return "ignored files exceed the inspection limit";
      for (const file of ignored.stdout.split("\0").filter(Boolean)) {
        // Only explicitly rebuildable output and isolated dev state may be discarded.
        if (/(^|\/)node_modules\/$/.test(file)) continue;
        if (!protectIgnored && (/(^|\/)(\.turbo|dist)\/$/.test(file) || file === ".cogenly/"))
          continue;
        // Setup links the parent's env; deleting a link cannot delete its target.
        if (yield* isLink(path.join(cwd, file.replace(/\/$/, "")))) continue;
        return `has ignored local files (${file})`;
      }
      return null;
    },
    Effect.mapError((cause) => new StorageInspectionError({ path: "worktree", cause })),
  );

  const volumes: StorageInspection["Service"]["volumes"] = Effect.fn("StorageInspection.volumes")(
    function* (paths) {
      const found = new Map<string, StorageVolume>();
      for (const requested of paths) {
        let target = path.resolve(requested);
        while (!(yield* fs.exists(target)) && path.dirname(target) !== target)
          target = path.dirname(target);
        const stat = yield* fs.stat(target);
        const id = String(stat.dev);
        if (found.has(id)) continue;
        const space = yield* Effect.tryPromise(() => NodeFSP.statfs(target));
        // stat/du cannot distinguish APFS clones or reflinks from private blocks.
        // Only report category sizes on filesystems with known block accounting.
        const sharedBlocksMayExist =
          platform !== "linux" || ![0xef53, 0x01021994].includes(Number(space.type));
        found.set(id, {
          id,
          path: target,
          totalBytes: space.blocks * space.bsize,
          usedBytes: (space.blocks - space.bfree) * space.bsize,
          availableBytes: space.bavail * space.bsize,
          sharedBlocksMayExist,
        });
      }
      return [...found.values()];
    },
    Effect.mapError((cause) => new StorageInspectionError({ path: "volume", cause })),
  );
  return StorageInspection.of({ measure, processBlocker, gitBlocker, volumes });
});

export const layer = Layer.effect(StorageInspection, make);

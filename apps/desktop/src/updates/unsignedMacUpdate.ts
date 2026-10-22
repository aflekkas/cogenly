// @effect-diagnostics nodeBuiltinImport:off -- The swap helper must be spawned detached and unref'd, and the zip is hashed while it streams to disk.
// @effect-diagnostics globalFetch:off -- One streamed release download that follows GitHub's asset redirects.
// In-app updates for unsigned (ad-hoc) macOS builds, which Squirrel.Mac refuses
// to install. The app downloads the release zip named by the channel feed,
// checks its sha512, extracts it, and hands the bundle swap to a detached shell
// helper that outlives the app. See docs/operations/release.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Written by every macOS start; the swap helper waits for it to call an update healthy. */
export const DESKTOP_UPDATE_LAUNCHED_MARKER_FILE = "desktop-update-launched";

export class UnsignedMacUpdateError extends Schema.TaggedError<UnsignedMacUpdateError>()(
  "UnsignedMacUpdateError",
  {
    step: Schema.Literals(["download", "verify", "extract", "install"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unsigned macOS update ${this.step} failed: ${this.detail}`;
  }
}

export interface MacUpdateZip {
  readonly url: string;
  readonly sha512: string;
  readonly size: number | undefined;
}

export interface PreparedMacUpdate {
  readonly version: string;
  /** Extracted bundle, ready to move into the install location. */
  readonly stagedBundlePath: string;
  /** Executable path relative to the bundle, from the update's Info.plist. */
  readonly executable: string;
}

/** `.../Name.app/Contents/Resources` → `.../Name.app`, or null outside a bundle. */
export function resolveMacAppBundlePath(resourcesPath: string): string | null {
  const contents = NodePath.dirname(resourcesPath);
  const bundle = NodePath.dirname(contents);
  if (NodePath.basename(resourcesPath) !== "Resources") return null;
  if (NodePath.basename(contents) !== "Contents") return null;
  return bundle.endsWith(".app") ? bundle : null;
}

/** Why this app cannot replace itself where it runs, or null when it can. */
export function unsignedMacInstallBlocker(input: {
  readonly bundlePath: string | null;
  readonly writable: boolean;
}): string | null {
  const { bundlePath, writable } = input;
  if (bundlePath === null) return "Cogenly could not find its app bundle.";
  if (bundlePath.includes("/AppTranslocation/")) {
    return "macOS is running Cogenly from a temporary copy. Move Cogenly to Applications and open it from there to update in place.";
  }
  if (writable) return null;
  if (bundlePath.startsWith("/Volumes/")) {
    return "Cogenly is running from its disk image. Drag it to Applications and open it from there to update in place.";
  }
  return `Cogenly cannot replace itself in ${NodePath.dirname(bundlePath)}. Move it to a folder you can write to, or install the update manually.`;
}

const UpdateInfoFiles = Schema.Struct({
  files: Schema.optional(
    Schema.Array(
      Schema.Struct({
        url: Schema.String,
        sha512: Schema.String,
        size: Schema.optional(Schema.Number),
      }),
    ),
  ),
});
const decodeUpdateInfoFiles = Schema.decodeUnknownOption(UpdateInfoFiles);

/** Picks the zip for this architecture from electron-updater's update info. */
export function selectMacUpdateZip(info: unknown, arch: string): MacUpdateZip | null {
  const decoded = decodeUpdateInfoFiles(info);
  const files = Option.isSome(decoded) ? (decoded.value.files ?? []) : [];
  const zips = files.filter((file) => file.url.endsWith(".zip"));
  const match = zips.find((file) => file.url.endsWith(`-${arch}.zip`)) ?? zips[0];
  return match ? { url: match.url, sha512: match.sha512, size: match.size } : null;
}

/** Drops variables that would change how the relaunched app starts. */
export function unsignedMacHelperEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === "ELECTRON_RUN_AS_NODE" || key === "ELECTRON_NO_ATTACH_CONSOLE") continue;
    result[key] = value;
  }
  return result;
}

/**
 * The detached swap helper. Arguments: app PID, install path, staged bundle,
 * backup path, new executable, old executable (both bundle-relative), launch
 * marker, log file, final path. The final path is where the update lands: the
 * install path, or a sibling with the update's own bundle name when a release
 * renames the app (Cogenly (Beta).app to Cogenly.app). The update and the rollback start the app through the
 * same `launch`, with the environment the app gave this helper.
 */
export const UNSIGNED_MAC_UPDATE_HELPER_SCRIPT = `#!/bin/sh
set -u
app_pid=$1 target=$2 staged=$3 backup=$4 new_exe=$5 old_exe=$6 marker=$7 log=$8 final=\${9:-$2}
quit_timeout=\${COGENLY_UPDATE_QUIT_TIMEOUT:-120}
start_timeout=\${COGENLY_UPDATE_START_TIMEOUT:-90}
exec >>"$log" 2>&1
say() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] $*"; }
# Starts a bundle detached from this shell so it is not left as our zombie.
launch() { launched_pid=$( ( "$1/$2" </dev/null >/dev/null 2>&1 & echo $! ) ); say "started $1 as $launched_pid"; }
gone_within() {
  ticks=0
  while kill -0 "$1" 2>/dev/null; do
    ticks=$((ticks + 1)); [ "$ticks" -gt $(($2 * 5)) ] && return 1; sleep 0.2
  done
  return 0
}
say "waiting for $app_pid to quit"
if ! gone_within "$app_pid" "$quit_timeout"; then say "the app did not quit; update abandoned"; exit 1; fi
rm -rf "$backup" "$backup.failed"
if ! mv "$target" "$backup"; then
  say "could not move the current app aside; update abandoned"; launch "$target" "$old_exe"; exit 1
fi
if ! mv "$staged" "$final"; then
  say "could not move the update into place; restoring"
  mv "$backup" "$target" && launch "$target" "$old_exe"; exit 1
fi
rm -f "$marker"
launch "$final" "$new_exe"; new_pid=$launched_pid
ticks=0
while [ ! -f "$marker" ]; do
  if ! kill -0 "$new_pid" 2>/dev/null; then say "the update exited while starting"; break; fi
  ticks=$((ticks + 1))
  if [ "$ticks" -gt $((start_timeout * 5)) ]; then
    say "the update did not finish starting; stopping $new_pid"
    kill "$new_pid" 2>/dev/null; gone_within "$new_pid" 10 || kill -9 "$new_pid" 2>/dev/null
    break
  fi
  sleep 0.2
done
if [ -f "$marker" ]; then say "update started"; rm -rf "$backup"; exit 0; fi
say "rolling back"
if mv "$final" "$backup.failed" && mv "$backup" "$target"; then
  rm -rf "$backup.failed"; launch "$target" "$old_exe"; exit 2
fi
say "rollback failed; the previous app is at $backup"; exit 3
`;

const run = (file: string, args: ReadonlyArray<string>, step: UnsignedMacUpdateError["step"]) =>
  Effect.callback<string, UnsignedMacUpdateError>((resume) => {
    NodeChildProcess.execFile(file, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      resume(
        error
          ? Effect.fail(
              new UnsignedMacUpdateError({
                step,
                detail: `${NodePath.basename(file)} exited: ${stderr.trim().slice(0, 300)}`,
                cause: error,
              }),
            )
          : Effect.succeed(stdout),
      );
    });
  });

const fsStep = <A>(step: UnsignedMacUpdateError["step"], detail: string, f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (cause) => new UnsignedMacUpdateError({ step, detail, cause }),
  });

export const isWritableMacInstall = (bundlePath: string) =>
  Effect.promise(async () => {
    try {
      await NodeFSP.access(bundlePath, NodeFSP.constants.W_OK);
      await NodeFSP.access(NodePath.dirname(bundlePath), NodeFSP.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  });

/** Streams the zip to disk, checking size and sha512 against the feed. */
const downloadZip = Effect.fn("desktop.updates.unsignedMac.download")(function* (input: {
  readonly url: string;
  readonly zip: MacUpdateZip;
  readonly destination: string;
  readonly onProgress: (percent: number) => Effect.Effect<void>;
}) {
  const response = yield* fsStep("download", "request failed", () => fetch(input.url));
  if (!response.ok || response.body === null) {
    return yield* new UnsignedMacUpdateError({
      step: "download",
      detail: `server answered ${response.status}`,
    });
  }
  const total = input.zip.size ?? Number(response.headers.get("content-length") ?? 0);
  const hash = NodeCrypto.createHash("sha512");
  let received = 0;
  yield* Effect.acquireUseRelease(
    fsStep("download", "could not create the download file", () =>
      NodeFSP.open(input.destination, "w"),
    ),
    (handle) =>
      Effect.gen(function* () {
        const reader = response.body!.getReader();
        while (true) {
          const chunk = yield* fsStep("download", "connection lost", () => reader.read());
          if (chunk.done) break;
          hash.update(chunk.value);
          received += chunk.value.byteLength;
          yield* fsStep("download", "could not write the download", () =>
            handle.write(chunk.value),
          );
          if (total > 0) yield* input.onProgress(Math.min(100, (received / total) * 100));
        }
      }),
    (handle) => Effect.promise(() => handle.close()),
  );
  if (input.zip.size !== undefined && received !== input.zip.size) {
    return yield* new UnsignedMacUpdateError({
      step: "verify",
      detail: `expected ${input.zip.size} bytes, received ${received}`,
    });
  }
  if (hash.digest("base64") !== input.zip.sha512) {
    return yield* new UnsignedMacUpdateError({
      step: "verify",
      detail: "sha512 does not match the update feed",
    });
  }
});

const readPlistValue = (plistPath: string, key: string) =>
  run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plistPath], "extract").pipe(
    Effect.map((value) => value.trim()),
  );

/**
 * Downloads, verifies, and extracts an update into `workDir` (recreated).
 * The extracted bundle must carry the expected version and the running bundle's identifier.
 */
export const prepareUnsignedMacUpdate = Effect.fn("desktop.updates.unsignedMac.prepare")(
  function* (input: {
    readonly version: string;
    readonly url: string;
    readonly zip: MacUpdateZip;
    readonly workDir: string;
    readonly currentBundlePath: string;
    readonly onProgress: (percent: number) => Effect.Effect<void>;
  }) {
    const expectedIdentifier = yield* readPlistValue(
      NodePath.join(input.currentBundlePath, "Contents", "Info.plist"),
      "CFBundleIdentifier",
    );
    const zipPath = NodePath.join(input.workDir, "update.zip");
    const extractDir = NodePath.join(input.workDir, "extracted");
    yield* fsStep("download", "could not prepare the update folder", async () => {
      await NodeFSP.rm(input.workDir, { recursive: true, force: true });
      await NodeFSP.mkdir(extractDir, { recursive: true });
    });
    yield* downloadZip({
      url: input.url,
      zip: input.zip,
      destination: zipPath,
      onProgress: input.onProgress,
    });
    yield* run("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir], "extract");
    yield* fsStep("extract", "could not remove the downloaded zip", () => NodeFSP.rm(zipPath));
    const bundles = (yield* fsStep("extract", "could not read the update", () =>
      NodeFSP.readdir(extractDir),
    )).filter((name) => name.endsWith(".app"));
    if (bundles.length !== 1) {
      return yield* new UnsignedMacUpdateError({
        step: "extract",
        detail: `expected one app bundle, found ${bundles.length}`,
      });
    }
    const stagedBundlePath = NodePath.join(extractDir, bundles[0]!);
    const plist = NodePath.join(stagedBundlePath, "Contents", "Info.plist");
    const version = yield* readPlistValue(plist, "CFBundleShortVersionString");
    const identifier = yield* readPlistValue(plist, "CFBundleIdentifier");
    const executableName = yield* readPlistValue(plist, "CFBundleExecutable");
    if (version !== input.version || identifier !== expectedIdentifier) {
      return yield* new UnsignedMacUpdateError({
        step: "verify",
        detail: `the update is ${identifier} ${version}, expected ${expectedIdentifier} ${input.version}`,
      });
    }
    // Downloads through fetch carry no quarantine; clear any a proxy or tool added.
    yield* run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", stagedBundlePath], "extract").pipe(
      Effect.ignore,
    );
    return {
      version,
      stagedBundlePath,
      executable: NodePath.join("Contents", "MacOS", executableName),
    } satisfies PreparedMacUpdate;
  },
);

/** Writes the helper and starts it detached; the caller then quits the app. */
export const startUnsignedMacSwap = Effect.fn("desktop.updates.unsignedMac.startSwap")(
  function* (input: {
    readonly prepared: PreparedMacUpdate;
    readonly appPid: number;
    readonly bundlePath: string;
    readonly currentExecutable: string;
    readonly workDir: string;
    readonly launchedMarkerPath: string;
    readonly logPath: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  }) {
    const scriptPath = NodePath.join(input.workDir, "swap-helper.sh");
    yield* fsStep("install", "could not write the update helper", () =>
      NodeFSP.writeFile(scriptPath, UNSIGNED_MAC_UPDATE_HELPER_SCRIPT, { mode: 0o755 }),
    );
    // A release that renames the app installs under the new name beside the old
    // bundle, which the swap removes. If that name is taken, update in place.
    const stagedName = NodePath.basename(input.prepared.stagedBundlePath);
    const renamedPath = NodePath.join(NodePath.dirname(input.bundlePath), stagedName);
    const finalPath =
      renamedPath === input.bundlePath ||
      (yield* Effect.promise(() =>
        NodeFSP.access(renamedPath).then(
          () => true,
          () => false,
        ),
      ))
        ? input.bundlePath
        : renamedPath;
    const args = [
      scriptPath,
      String(input.appPid),
      input.bundlePath,
      input.prepared.stagedBundlePath,
      NodePath.join(input.workDir, NodePath.basename(input.bundlePath)),
      input.prepared.executable,
      input.currentExecutable,
      input.launchedMarkerPath,
      input.logPath,
      finalPath,
    ];
    yield* Effect.callback<void, UnsignedMacUpdateError>((resume) => {
      const child = NodeChildProcess.spawn("/bin/sh", args, {
        detached: true,
        stdio: "ignore",
        env: unsignedMacHelperEnvironment(input.env),
      });
      child.once("error", (cause) =>
        resume(
          Effect.fail(
            new UnsignedMacUpdateError({
              step: "install",
              detail: "could not start the update helper",
              cause,
            }),
          ),
        ),
      );
      child.once("spawn", () => {
        child.unref();
        resume(Effect.void);
      });
    });
  },
);

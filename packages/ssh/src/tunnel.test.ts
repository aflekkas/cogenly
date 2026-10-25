import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { buildRemoteLaunchScript, buildRemoteT3RunnerScript } from "./tunnel.ts";

const VERSION = "9.9.9";
// An origin that fails any fetch, proving a case never downloads.
const UNREACHABLE_ORIGIN = "file:///nonexistent-cogenly-mirror";

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const run = Effect.fn("test.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = { PATH: "/usr/bin:/bin" },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(command, args, { env, extendEnv: false }));
  const [stdout, stderr, code] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), Effect.map(child.exitCode, Number)],
    { concurrency: "unbounded" },
  );
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
});

/**
 * The archive name the runner derives from `uname` on this machine; `t3` is
 * the name of releases from before the rename.
 */
const archiveName = (prefix: "cogenly" | "t3" = "cogenly") =>
  Effect.gen(function* () {
    return `${prefix}-${VERSION}-${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}.tar.gz`;
  });

/** An executable that prints its label and arguments, standing in for `t3`/`cogenly`. */
const writeFakeExecutable = Effect.fn("test.writeFakeExecutable")(function* (
  file: string,
  label: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(
    file,
    `#!/bin/sh\nif [ "$*" = "security setup --help" ]; then echo --local; else echo "${label} $*"; fi\n`,
  );
  yield* fs.chmod(file, 0o755);
});

/** A complete pinned runtime; `t3` is the executable of one unpacked before the rename. */
const pinRuntime = Effect.fn("test.pinRuntime")(function* (
  home: string,
  version: string,
  executable: "cogenly" | "t3" = "cogenly",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(home, ".cogenly/runtime/versions", version);
  yield* writeFakeExecutable(path.join(dir, executable), `pinned-${version}`);
  yield* fs.writeFileString(path.join(dir, ".install-complete"), `${version}\n`);
});

/** A file:// release mirror laid out like GitHub's releases/download/<tag>/. */
const writeMirror = Effect.fn("test.writeMirror")(function* (
  listArchive: boolean,
  prefix: "cogenly" | "t3" = "cogenly",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const archive = yield* archiveName(prefix);
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-ssh-mirror-" });
  const releaseDir = path.join(root, `v${VERSION}`);
  const stem = archive.replace(/\.tar\.gz$/, "");
  // Archives from before the rename hold only `t3`.
  yield* writeFakeExecutable(path.join(root, "stage", stem, prefix), `downloaded-${prefix}`);
  yield* fs.makeDirectory(releaseDir, { recursive: true });
  const archivePath = path.join(releaseDir, archive);
  const tar = yield* run("tar", ["-czf", archivePath, "-C", path.join(root, "stage"), stem]);
  expect(tar.code).toBe(0);
  const bytes = yield* fs.readFile(archivePath);
  const digest = Hex.encode(
    new Uint8Array(
      yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
    ),
  );
  yield* fs.writeFileString(
    path.join(releaseDir, "SHA256SUMS"),
    listArchive ? `${digest}  ${archive}\n` : `${"0".repeat(64)}  Cogenly-${VERSION}-arm64.zip\n`,
  );
  return `file://${root}`;
});

const runRunner = Effect.fn("test.runRunner")(function* (home: string, releaseBaseUrl: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runnerPath = path.join(home, "run-t3.sh");
  yield* fs.writeFileString(
    runnerPath,
    buildRemoteT3RunnerScript({ archiveVersion: VERSION, releaseBaseUrl }),
  );
  return yield* run("/bin/sh", [runnerPath, "serve", "--port", "4773"], {
    HOME: home,
    PATH: `${home}/bin:/usr/bin:/bin`,
  });
});

const makeHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-ssh-home-" });
});

describe("SSH runner install selection", () => {
  it.effect("runs the runtime pinned for the desktop's exact version", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      yield* pinRuntime(home, VERSION);
      yield* pinRuntime(home, "10.0.0");
      expect(yield* runRunner(home, UNREACHABLE_ORIGIN)).toMatchObject({
        code: 0,
        stdout: "pinned-9.9.9 serve --port 4773",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses a cogenly command the host already has instead of downloading", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* makeHome;
      yield* writeFakeExecutable(path.join(home, ".local/bin/cogenly"), "installed");
      yield* pinRuntime(home, "0.1.5");
      expect(yield* runRunner(home, UNREACHABLE_ORIGIN)).toMatchObject({
        code: 0,
        stdout: "installed serve --port 4773",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to the newest complete pinned runtime, such as the service's", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* makeHome;
      yield* pinRuntime(home, "0.1.9");
      // Unpacked before the rename, so its executable is still `t3`.
      yield* pinRuntime(home, "0.1.10", "t3");
      // No sentinel: an interrupted install is never picked.
      yield* writeFakeExecutable(path.join(home, ".cogenly/runtime/versions/0.2.0/t3"), "partial");
      expect(yield* runRunner(home, UNREACHABLE_ORIGIN)).toMatchObject({
        code: 0,
        stdout: "pinned-0.1.10 serve --port 4773",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("downloads and verifies the exact version when the host has no Cogenly", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeHome;
      const result = yield* runRunner(home, yield* writeMirror(true));
      expect(result).toMatchObject({ code: 0, stdout: "downloaded-cogenly serve --port 4773" });
      expect(
        yield* fs.readFileString(
          path.join(home, ".cogenly/runtime/versions", VERSION, ".install-complete"),
        ),
      ).toBe(`${VERSION}\n`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a Linux archive install provisions the sandbox without corrupting stdout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeHome;
      yield* fs.makeDirectory(path.join(home, "bin"));
      const uname = path.join(home, "bin/uname");
      yield* fs.writeFileString(
        uname,
        '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else exec /usr/bin/uname "$@"; fi\n',
      );
      yield* fs.chmod(uname, 0o755);
      const mirror = yield* writeMirror(true).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      const cold = yield* runRunner(home, mirror);
      expect(cold).toMatchObject({ code: 0, stdout: "downloaded-cogenly serve --port 4773" });
      expect(cold.stderr).toContain("downloaded-cogenly security setup --local");
      const warm = yield* runRunner(home, mirror);
      expect(warm).toMatchObject({ code: 0, stdout: "downloaded-cogenly serve --port 4773" });
      expect(warm.stderr).not.toContain("security setup");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("downloads the t3 archive of a release from before the rename", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      const result = yield* runRunner(home, yield* writeMirror(true, "t3"));
      expect(result).toMatchObject({ code: 0, stdout: "downloaded-t3 serve --port 4773" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("explains a release without an archive for this host", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeHome;
      const result = yield* runRunner(home, yield* writeMirror(false));
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(`Could not download ${yield* archiveName()}`);
      expect(yield* fs.exists(path.join(home, ".cogenly/runtime/versions", VERSION))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

/** A pinned runtime whose helpers answer at once, and that logs any server it is asked to run. */
const pinHelperRuntime = Effect.fn("test.pinHelperRuntime")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(home, ".cogenly/runtime/versions", VERSION);
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(
    path.join(dir, "t3"),
    [
      "#!/bin/sh",
      'case "$1" in',
      "  --version) echo 9.9.9 ;;",
      '  __ssh-helper) case "$2" in',
      '    runtime-port) [ -f "$3" ] || exit 1; cat "$3" ;;',
      "    wait-ready) exit 0 ;;",
      "    pick-port) echo 5999 ;;",
      "  esac ;;",
      '  *) echo "$*" >>"$HOME/launched" ;;',
      "esac",
      "",
    ].join("\n"),
  );
  yield* fs.chmod(path.join(dir, "t3"), 0o755);
  yield* fs.writeFileString(path.join(dir, ".install-complete"), `${VERSION}\n`);
});

/** A `systemctl` that knows `cogenly.service` when `installed`, and whose start writes its runtime file. */
const writeFakeSystemctl = Effect.fn("test.writeFakeSystemctl")(function* (
  home: string,
  installed: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(home, "bin/systemctl");
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(
    file,
    [
      "#!/bin/sh",
      'echo "$*" >>"$HOME/systemctl.log"',
      'case "$2" in',
      `  cat) exit ${installed ? 0 : 1} ;;`,
      '  start) mkdir -p "$HOME/.cogenly/userdata"; echo "4242 4773" >"$HOME/.cogenly/userdata/server-runtime.json" ;;',
      "esac",
      "",
    ].join("\n"),
  );
  yield* fs.chmod(file, 0o755);
});

const runLaunch = Effect.fn("test.runLaunch")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scriptPath = path.join(home, "launch.sh");
  yield* fs.writeFileString(
    scriptPath,
    buildRemoteLaunchScript({ archiveVersion: VERSION, releaseBaseUrl: UNREACHABLE_ORIGIN }),
  );
  return yield* run("/bin/sh", [scriptPath, "state-key"], {
    HOME: home,
    PATH: `${home}/bin:/usr/bin:/bin`,
  });
});

describe("SSH launch with an installed background service", () => {
  it.effect("starts the stopped service and uses it instead of a second server", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeHome;
      yield* pinHelperRuntime(home);
      yield* writeFakeSystemctl(home, true);
      const result = yield* runLaunch(home);
      expect(result).toMatchObject({
        code: 0,
        stdout: '{"remotePort":4773,"serverKind":"external"}',
      });
      expect(yield* fs.readFileString(path.join(home, "systemctl.log"))).toContain(
        "--user start cogenly.service",
      );
      expect(yield* fs.exists(path.join(home, "launched"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("launches its own server when no service is installed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeHome;
      yield* pinHelperRuntime(home);
      yield* writeFakeSystemctl(home, false);
      const result = yield* runLaunch(home);
      expect(result).toMatchObject({
        code: 0,
        stdout: '{"remotePort":5999,"serverKind":"managed"}',
      });
      expect(yield* fs.readFileString(path.join(home, "systemctl.log"))).not.toContain("start");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

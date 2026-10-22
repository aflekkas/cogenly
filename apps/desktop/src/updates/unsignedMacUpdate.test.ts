// @effect-diagnostics nodeBuiltinImport:off -- Runs the real swap helper against fake bundles on disk.
// @effect-diagnostics globalTimers:off -- Waits briefly for detached fake bundles to record their launch.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  UNSIGNED_MAC_UPDATE_HELPER_SCRIPT,
  resolveMacAppBundlePath,
  selectMacUpdateZip,
  unsignedMacHelperEnvironment,
  unsignedMacInstallBlocker,
} from "./unsignedMacUpdate.ts";

describe("unsigned macOS install location", () => {
  it("finds the bundle from the resources path", () => {
    expect(resolveMacAppBundlePath("/Applications/Cogenly.app/Contents/Resources")).toBe(
      "/Applications/Cogenly.app",
    );
    expect(resolveMacAppBundlePath("/opt/cogenly/resources")).toBeNull();
  });

  it("updates writable installs in place and explains every other location", () => {
    expect(
      unsignedMacInstallBlocker({ bundlePath: "/Applications/Cogenly.app", writable: true }),
    ).toBeNull();
    expect(
      unsignedMacInstallBlocker({
        bundlePath: "/private/var/folders/x/AppTranslocation/ABC/d/Cogenly.app",
        writable: true,
      }),
    ).toContain("temporary copy");
    expect(
      unsignedMacInstallBlocker({ bundlePath: "/Volumes/Cogenly/Cogenly.app", writable: false }),
    ).toContain("disk image");
    expect(
      unsignedMacInstallBlocker({ bundlePath: "/Applications/Cogenly.app", writable: false }),
    ).toContain("cannot replace itself in /Applications");
  });

  it("picks this architecture's zip from the feed", () => {
    const info = {
      files: [
        { url: "Cogenly-1.0.0-x64.zip", sha512: "x", size: 1 },
        { url: "Cogenly-1.0.0-arm64.zip", sha512: "a", size: 2 },
        { url: "Cogenly-1.0.0-arm64.dmg", sha512: "d", size: 3 },
      ],
    };
    expect(selectMacUpdateZip(info, "arm64")).toEqual({
      url: "Cogenly-1.0.0-arm64.zip",
      sha512: "a",
      size: 2,
    });
    expect(selectMacUpdateZip({ files: [] }, "arm64")).toBeNull();
    expect(selectMacUpdateZip("garbage", "arm64")).toBeNull();
  });
});

describe("unsigned macOS swap helper", () => {
  const roots: Array<string> = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true })));
  });

  const writeBundle = async (bundle: string, body: string) => {
    const macos = NodePath.join(bundle, "Contents", "MacOS");
    await NodeFSP.mkdir(macos, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(macos, "Cogenly"), `#!/bin/sh\n${body}\n`, {
      mode: 0o755,
    });
  };

  const setup = async (newBundleBody: string) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cogenly-swap-"));
    roots.push(root);
    const paths = {
      target: NodePath.join(root, "Applications", "Cogenly.app"),
      staged: NodePath.join(root, "work", "extracted", "Cogenly.app"),
      backup: NodePath.join(root, "work", "Cogenly.app"),
      marker: NodePath.join(root, "launched"),
      record: NodePath.join(root, "launches"),
      log: NodePath.join(root, "helper.log"),
      script: NodePath.join(root, "helper.sh"),
    };
    await writeBundle(
      paths.target,
      `echo "old home=$COGENLY_HOME node=\${ELECTRON_RUN_AS_NODE:-unset}" >> "$RECORD"`,
    );
    await writeBundle(paths.staged, newBundleBody);
    await NodeFSP.writeFile(paths.script, UNSIGNED_MAC_UPDATE_HELPER_SCRIPT, { mode: 0o755 });
    return paths;
  };

  // The quitting app: a process that exits shortly after the helper starts.
  const runHelper = async (paths: Awaited<ReturnType<typeof setup>>) => {
    const app = NodeChildProcess.spawn("/bin/sh", ["-c", "sleep 0.3"]);
    const env = unsignedMacHelperEnvironment({
      PATH: process.env.PATH,
      COGENLY_HOME: "/users/me/.cogenly",
      ELECTRON_RUN_AS_NODE: "1",
      RECORD: paths.record,
      MARKER: paths.marker,
      COGENLY_UPDATE_START_TIMEOUT: "5",
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      NodeChildProcess.execFile(
        "/bin/sh",
        [
          paths.script,
          String(app.pid),
          paths.target,
          paths.staged,
          paths.backup,
          "Contents/MacOS/Cogenly",
          "Contents/MacOS/Cogenly",
          paths.marker,
          paths.log,
        ],
        { env },
        (error) => resolve(error === null ? 0 : (error.code as number)),
      );
    });
    return exitCode;
  };

  // Launched bundles run detached from the helper, so their record can land
  // just after it exits.
  const readLaunches = async (record: string, count: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const lines = await NodeFSP.readFile(record, "utf8").then(
        (text) => text.trim().split("\n"),
        () => [],
      );
      if (lines.length >= count) return lines;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`expected ${count} launches in ${record}`);
  };

  it("swaps in the update and starts it with the app's environment", async () => {
    const paths = await setup(
      `echo "new home=$COGENLY_HOME node=\${ELECTRON_RUN_AS_NODE:-unset}" >> "$RECORD"; echo 1.0.1 > "$MARKER"`,
    );
    expect(await runHelper(paths)).toBe(0);
    expect(await readLaunches(paths.record, 1)).toEqual(["new home=/users/me/.cogenly node=unset"]);
    const installed = await NodeFSP.readFile(
      NodePath.join(paths.target, "Contents", "MacOS", "Cogenly"),
      "utf8",
    );
    expect(installed).toContain("new");
    await expect(NodeFSP.access(paths.backup)).rejects.toThrow();
  });

  it("restores the old bundle and starts it the same way when the update fails to start", async () => {
    const paths = await setup(
      `echo "new home=$COGENLY_HOME node=\${ELECTRON_RUN_AS_NODE:-unset}" >> "$RECORD"; exit 1`,
    );
    // A marker left by an earlier start must not count for this launch.
    await NodeFSP.writeFile(paths.marker, "stale");
    expect(await runHelper(paths)).toBe(2);
    expect(await readLaunches(paths.record, 2)).toEqual([
      "new home=/users/me/.cogenly node=unset",
      "old home=/users/me/.cogenly node=unset",
    ]);
    const installed = await NodeFSP.readFile(
      NodePath.join(paths.target, "Contents", "MacOS", "Cogenly"),
      "utf8",
    );
    expect(installed).toContain("old");
    expect(await NodeFSP.readFile(paths.log, "utf8")).toContain("rolling back");
  });
});

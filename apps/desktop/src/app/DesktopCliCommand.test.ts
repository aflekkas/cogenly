// @effect-diagnostics nodeBuiltinImport:off -- The tests run the generated sh scripts as real processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach } from "vite-plus/test";

import * as DesktopCliCommand from "./DesktopCliCommand.ts";
import * as DesktopCliShim from "./DesktopCliShim.ts";

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    // A test may leave its "system" folder read-only, as /usr/local/bin is.
    NodeChildProcess.spawnSync("chmod", ["-R", "u+w", root]);
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

/** A fake install: a home, a system folder, and an "app" that prints how the launcher ran it. */
const sandbox = () => {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cli-cmd-")));
  roots.push(root);
  const home = NodePath.join(root, "home");
  const system = NodePath.join(root, "usr-local-bin");
  const makeApp = (name: string) => {
    const executable = NodePath.join(root, `${name}.app`, "Contents", "MacOS", name);
    NodeFS.mkdirSync(NodePath.dirname(executable), { recursive: true });
    NodeFS.writeFileSync(
      executable,
      '#!/bin/sh\necho "$ELECTRON_RUN_AS_NODE|$COGENLY_HOME|$COGENLY_CLI_PATH|$*"\n',
      { mode: 0o755 },
    );
    return executable;
  };
  NodeFS.mkdirSync(home, { recursive: true });
  NodeFS.mkdirSync(system, { recursive: true });
  return { root, home, system, userBin: NodePath.join(home, ".local", "bin"), makeApp };
};

type Sandbox = ReturnType<typeof sandbox>;

/** Runs the root script as this user, briefly making a read-only folder writable as root would find it. */
const runAsFakeRoot = (box: Sandbox, calls: Array<string>) => (script: string) =>
  Effect.sync(() => {
    calls.push(script);
    NodeFS.chmodSync(box.system, 0o755);
    const result = NodeChildProcess.spawnSync("sh", ["-c", script], { encoding: "utf8" });
    NodeFS.chmodSync(box.system, 0o555);
    return result;
  }).pipe(
    Effect.flatMap((result) =>
      result.status === 0
        ? Effect.void
        : Effect.fail(new DesktopCliCommand.DesktopCliCommandError({ message: result.stderr })),
    ),
  );

const makeCommand = (
  box: Sandbox,
  options: {
    readonly app: string | null;
    readonly path: ReadonlyArray<string>;
    readonly adminCalls?: Array<string>;
    readonly systemDirectory?: string | null;
    readonly legacyDirectories?: ReadonlyArray<string>;
  },
) =>
  DesktopCliCommand.makeUnix({
    homeDirectory: box.home,
    shim:
      options.app === null
        ? null
        : {
            target: {
              kind: "direct",
              executable: options.app,
              entry: `${NodePath.dirname(NodePath.dirname(options.app))}/Resources/app.asar/apps/server/dist/bin.mjs`,
            },
            t3Home: NodePath.join(box.home, ".cogenly"),
          },
    systemDirectory: options.systemDirectory === undefined ? box.system : options.systemDirectory,
    legacyDirectories: options.legacyDirectories ?? [],
    loginPath: Effect.succeed(options.path.join(":")),
    runAsAdmin: runAsFakeRoot(box, options.adminCalls ?? []),
  }).pipe(Effect.provide(NodeServices.layer));

const run = (file: string, args: ReadonlyArray<string> = []) =>
  NodeChildProcess.spawnSync(file, args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });

describe("DesktopCliCommand on macOS and Linux", () => {
  it.effect("installs a marked launcher in ~/.local/bin that runs the app against its home", () =>
    Effect.gen(function* () {
      const box = sandbox();
      const app = box.makeApp("Cogenly");
      const command = yield* makeCommand(box, { app, path: [box.userBin, "/usr/bin"] });

      assert.strictEqual((yield* command.state).status, "not-installed");
      const state = yield* command.install({});
      const file = NodePath.join(box.userBin, "cogenly");

      assert.deepStrictEqual(state, {
        supported: true,
        status: "installed",
        installedPath: file,
        appPath: NodePath.join(box.root, "Cogenly.app"),
        upToDate: true,
        onPath: true,
        userDirectory: box.userBin,
        userDirectoryOnPath: true,
        systemDirectory: box.system,
        recommendedLocation: "user",
      });
      const content = NodeFS.readFileSync(file, "utf8");
      assert.include(content.split("\n")[1], DesktopCliShim.MARKER);
      assert.strictEqual(NodeFS.statSync(file).mode & 0o777, 0o755);
      // A symlink could not carry the env; the launcher sets it and passes arguments through.
      assert.isFalse(NodeFS.lstatSync(file).isSymbolicLink());
      const result = run(file, ["project", "list"]);
      assert.strictEqual(result.status, 0);
      assert.strictEqual(
        result.stdout.trim(),
        `1|${NodePath.join(box.home, ".cogenly")}|${file}|${NodePath.join(box.root, "Cogenly.app")}/Contents/Resources/app.asar/apps/server/dist/bin.mjs project list`,
      );
    }),
  );

  it.effect("recommends /usr/local/bin only when ~/.local/bin is off the login PATH", () =>
    Effect.gen(function* () {
      const box = sandbox();
      const app = box.makeApp("Cogenly");
      const onPath = yield* makeCommand(box, { app, path: [box.userBin] });
      const offPath = yield* makeCommand(box, { app, path: ["/usr/bin"] });
      const noSystem = yield* makeCommand(box, {
        app,
        path: ["/usr/bin"],
        systemDirectory: null,
      });

      assert.strictEqual((yield* onPath.state).recommendedLocation, "user");
      const off = yield* offPath.state;
      assert.isFalse(off.userDirectoryOnPath);
      assert.strictEqual(off.recommendedLocation, "system");
      assert.strictEqual((yield* noSystem.state).recommendedLocation, "user");
      const refused = yield* noSystem.install({ location: "system" }).pipe(Effect.flip);
      assert.include(refused.message, "only on macOS");
    }),
  );

  it.effect("installs to a read-only /usr/local/bin through the admin prompt", () =>
    Effect.gen(function* () {
      const box = sandbox();
      const app = box.makeApp("Cogenly");
      NodeFS.chmodSync(box.system, 0o555);
      const adminCalls: Array<string> = [];
      const command = yield* makeCommand(box, { app, path: [box.system], adminCalls });

      const state = yield* command.install({});
      const file = NodePath.join(box.system, "cogenly");

      assert.strictEqual(adminCalls.length, 1);
      assert.strictEqual(state.status, "installed");
      assert.strictEqual(state.installedPath, file);
      assert.isTrue(state.onPath);
      assert.strictEqual(run(file).status, 0);

      // Uninstalling it needs the prompt again, and leaves the folder empty.
      const removed = yield* command.uninstall;
      assert.strictEqual(adminCalls.length, 2);
      assert.strictEqual(removed.status, "not-installed");
      assert.deepStrictEqual(NodeFS.readdirSync(box.system), []);
    }),
  );

  it.effect("never overwrites or removes a cogenly it did not write", () =>
    Effect.gen(function* () {
      const box = sandbox();
      const app = box.makeApp("Cogenly");
      const legacy = NodePath.join(box.root, "legacy-bin");
      NodeFS.mkdirSync(box.userBin, { recursive: true });
      NodeFS.mkdirSync(legacy);
      const foreign = NodePath.join(box.userBin, "cogenly");
      const foreignLegacy = NodePath.join(legacy, "cogenly");
      NodeFS.writeFileSync(foreign, "#!/bin/sh\necho someone else's\n", { mode: 0o755 });
      NodeFS.writeFileSync(foreignLegacy, "#!/bin/sh\necho another\n", { mode: 0o755 });
      const command = yield* makeCommand(box, {
        app,
        path: [box.userBin],
        legacyDirectories: [legacy],
      });

      const state = yield* command.state;
      assert.strictEqual(state.status, "foreign");
      assert.strictEqual(state.foreignPath, foreign);

      const refused = yield* command.install({ location: "user" }).pipe(Effect.flip);
      assert.include(refused.message, "was not installed by Cogenly");
      yield* command.uninstall;
      assert.strictEqual(NodeFS.readFileSync(foreign, "utf8"), "#!/bin/sh\necho someone else's\n");
      assert.strictEqual(NodeFS.readFileSync(foreignLegacy, "utf8"), "#!/bin/sh\necho another\n");
    }),
  );

  it.effect("the root install script refuses a foreign file on its own", () =>
    Effect.sync(() => {
      const box = sandbox();
      const source = NodePath.join(box.root, "staged");
      const destination = NodePath.join(box.system, "cogenly");
      NodeFS.writeFileSync(source, `#!/bin/sh\n# ${DesktopCliShim.MARKER}\n`);
      NodeFS.writeFileSync(destination, "not ours\n");

      const script = DesktopCliCommand.systemInstallScript({ source, destination });
      const result = NodeChildProcess.spawnSync("sh", ["-c", script], { encoding: "utf8" });

      assert.strictEqual(result.status, 3);
      assert.include(result.stderr, "was not installed by Cogenly");
      assert.strictEqual(NodeFS.readFileSync(destination, "utf8"), "not ours\n");
    }),
  );

  it.effect("reports a launcher whose app is gone as stale, and Install repoints it", () =>
    Effect.gen(function* () {
      const box = sandbox();
      const oldApp = box.makeApp("Old");
      const previous = yield* makeCommand(box, { app: oldApp, path: [box.userBin] });
      yield* previous.install({});
      NodeFS.rmSync(NodePath.join(box.root, "Old.app"), { recursive: true });

      const app = box.makeApp("Cogenly");
      const command = yield* makeCommand(box, { app, path: [box.userBin] });
      const stale = yield* command.state;
      assert.strictEqual(stale.status, "stale");
      assert.strictEqual(stale.appPath, NodePath.join(box.root, "Old.app"));
      assert.isFalse(stale.upToDate);
      const moved = run(NodePath.join(box.userBin, "cogenly"));
      assert.strictEqual(moved.status, 127);
      assert.include(moved.stderr, "moved or been removed");

      const repointed = yield* command.install({});
      assert.strictEqual(repointed.status, "installed");
      assert.strictEqual(repointed.appPath, NodePath.join(box.root, "Cogenly.app"));
      assert.isTrue(repointed.upToDate);
    }),
  );

  it.effect("says when another cogenly earlier on PATH shadows the installed one", () =>
    Effect.gen(function* () {
      const box = sandbox();
      const app = box.makeApp("Cogenly");
      const earlier = NodePath.join(box.root, "earlier");
      NodeFS.mkdirSync(earlier);
      NodeFS.writeFileSync(NodePath.join(earlier, "cogenly"), "#!/bin/sh\n", { mode: 0o755 });
      const command = yield* makeCommand(box, { app, path: [earlier, box.userBin] });

      const state = yield* command.install({});
      assert.strictEqual(state.status, "installed");
      assert.isFalse(state.onPath);
      assert.strictEqual(state.foreignPath, NodePath.join(earlier, "cogenly"));
    }),
  );

  it.effect("finds and removes a link an older build made, but not the launcher it points at", () =>
    Effect.gen(function* () {
      const box = sandbox();
      const app = box.makeApp("Cogenly");
      const legacy = NodePath.join(box.root, "homebrew-bin");
      const launcher = NodePath.join(box.home, ".cogenly", "bin", "cogenly");
      NodeFS.mkdirSync(legacy);
      NodeFS.mkdirSync(NodePath.dirname(launcher), { recursive: true });
      NodeFS.writeFileSync(
        launcher,
        DesktopCliShim.renderCliShim({
          target: { kind: "direct", executable: app, entry: "/entry.mjs" },
          shimPath: launcher,
          t3Home: NodePath.join(box.home, ".cogenly"),
        }),
        { mode: 0o755 },
      );
      NodeFS.symlinkSync(launcher, NodePath.join(legacy, "cogenly"));
      const command = yield* makeCommand(box, {
        app,
        path: [legacy],
        legacyDirectories: [legacy],
      });

      const state = yield* command.state;
      assert.strictEqual(state.status, "installed");
      assert.strictEqual(state.installedPath, NodePath.join(legacy, "cogenly"));
      assert.isTrue(state.onPath);

      assert.strictEqual((yield* command.uninstall).status, "not-installed");
      assert.isFalse(NodeFS.existsSync(NodePath.join(legacy, "cogenly")));
      assert.isTrue(NodeFS.existsSync(launcher));
    }),
  );

  it.effect("is unsupported, and refuses to install, in a build with no CLI", () =>
    Effect.gen(function* () {
      const box = sandbox();
      const command = yield* makeCommand(box, { app: null, path: [box.userBin] });
      assert.isFalse((yield* command.state).supported);
      const refused = yield* command.install({}).pipe(Effect.flip);
      assert.include(refused.message, "installed Cogenly app");
    }),
  );
});

describe("launcher text", () => {
  it("reads back the app path a launcher runs, quotes included", () => {
    const executable = "/Applications/Bob's Cogenly.app/Contents/MacOS/Cogenly";
    const content = DesktopCliShim.renderCliShim({
      target: { kind: "direct", executable, entry: "/entry.mjs" },
      shimPath: "/usr/local/bin/cogenly",
      t3Home: "/Users/bob/.cogenly",
    });
    assert.strictEqual(DesktopCliShim.parseCliShimApp(content), executable);
    assert.strictEqual(
      DesktopCliCommand.appBundleOf(executable),
      "/Applications/Bob's Cogenly.app",
    );
    assert.strictEqual(DesktopCliShim.parseCliShimApp("#!/bin/sh\necho hi\n"), null);
  });

  it("escapes the root script into one AppleScript string", () => {
    const command = DesktopCliCommand.appleScriptAdminCommand(
      `echo "a\\b"\necho 'c'`,
      "Cogenly wants to install the cogenly command in /usr/local/bin.",
    );
    assert.strictEqual(
      command,
      `do shell script "echo \\"a\\\\b\\"\\necho 'c'" with prompt "Cogenly wants to install the cogenly command in /usr/local/bin." with administrator privileges`,
    );
  });
});

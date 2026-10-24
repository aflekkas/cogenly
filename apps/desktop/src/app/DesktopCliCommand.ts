import type {
  DesktopCliCommandChangeResult,
  DesktopCliCommandInstallInput,
  DesktopCliCommandLocation,
  DesktopCliCommandState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopCliShim from "./DesktopCliShim.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

// Settings → `cogenly` command, like VS Code's "Install 'code' command". On macOS
// and Linux, installing writes a small sh launcher for the app's bundled CLI
// (see DesktopCliShim) to ~/.local/bin, or on macOS to /usr/local/bin after the
// system's admin prompt. The launcher carries DesktopCliShim.MARKER, which is how
// the app tells its own file from someone else's: it only ever overwrites or
// removes a file with the marker. On Windows, installing adds the launcher's
// folder in the Cogenly home to the user's PATH, and removing takes out only the
// entry the app recorded adding.

export class DesktopCliCommandError extends Schema.TaggedError<DesktopCliCommandError>()(
  "DesktopCliCommandError",
  { message: Schema.String },
) {}

export class DesktopCliCommand extends Context.Service<
  DesktopCliCommand,
  {
    readonly state: Effect.Effect<DesktopCliCommandState>;
    readonly install: (
      input: DesktopCliCommandInstallInput,
    ) => Effect.Effect<DesktopCliCommandState, DesktopCliCommandError>;
    readonly uninstall: Effect.Effect<DesktopCliCommandState, DesktopCliCommandError>;
  }
>()("@t3tools/desktop/app/DesktopCliCommand") {}

/** An install or uninstall as the renderer hears it: a refusal comes back with the state, not as a throw. */
export const toChangeResult = (
  service: DesktopCliCommand["Service"],
  change: Effect.Effect<DesktopCliCommandState, DesktopCliCommandError>,
): Effect.Effect<DesktopCliCommandChangeResult> =>
  change.pipe(
    Effect.map((state) => ({ ok: true as const, state })),
    Effect.catchTags({
      DesktopCliCommandError: (error) =>
        Effect.map(service.state, (state) => ({
          ok: false as const,
          message: error.message,
          state,
        })),
    }),
  );

const unsupported: DesktopCliCommandState = {
  supported: false,
  status: "not-installed",
  installedPath: null,
  appPath: null,
  upToDate: true,
  onPath: false,
  userDirectory: null,
  userDirectoryOnPath: false,
  systemDirectory: null,
  recommendedLocation: "user",
};

/** The launcher is a few KB; never read a large binary someone else named `cogenly`. */
const MAX_SHIM_BYTES = 16_384;

const shellWord = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const pathEntries = (value: string | undefined, separator: string) =>
  (value ?? "")
    .split(separator)
    .map((entry) => (entry.length > 1 ? entry.replace(/\/+$/, "") : entry))
    .filter((entry) => entry.length > 0);

/** `/Applications/Cogenly.app` for the executable inside it; any other path as it is. */
export const appBundleOf = (executable: string) =>
  /^(.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(executable)?.[1] ?? executable;

/**
 * Root's half of a system install: refuses a `cogenly` without the marker, then
 * moves the staged launcher into place. Runs after the admin prompt, so the
 * check happens again here rather than trusting the earlier look.
 */
export const systemInstallScript = (input: {
  readonly source: string;
  readonly destination: string;
}) => {
  const destination = shellWord(input.destination);
  const staged = shellWord(`${input.destination}.cogenly-tmp`);
  return [
    "set -e",
    `if [ -e ${destination} ] || [ -L ${destination} ]; then`,
    `  grep -qF ${shellWord(DesktopCliShim.MARKER)} ${destination} || { echo ${shellWord(`${input.destination} was not installed by Cogenly, so it was left alone.`)} >&2; exit 3; }`,
    "fi",
    `mkdir -p ${shellWord(input.destination.replace(/\/[^/]+$/, "") || "/")}`,
    `cp ${shellWord(input.source)} ${staged}`,
    `chmod 755 ${staged}`,
    `mv -f ${staged} ${destination}`,
  ].join("\n");
};

/** Root's half of an uninstall: removes each file that still carries the marker. */
const systemUninstallScript = (files: ReadonlyArray<string>) =>
  files
    .map(
      (file) =>
        `if grep -qF ${shellWord(DesktopCliShim.MARKER)} ${shellWord(file)}; then rm -f ${shellWord(file)}; fi`,
    )
    .join("\n");

/** What the macOS admin prompt runs: `script` under `sh` as root, after the user approves. */
export const appleScriptAdminCommand = (script: string, prompt: string) => {
  const literal = (value: string) =>
    `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
  return `do shell script ${literal(script)} with prompt ${literal(prompt)} with administrator privileges`;
};

/** What the Unix command depends on outside the filesystem, so tests can stand in for it. */
export interface UnixCliCommandHost {
  readonly homeDirectory: string;
  /** What the launcher runs, and the Cogenly home it targets. Null for a build with no CLI to install. */
  readonly shim: {
    readonly target: DesktopCliShim.CliShimTarget;
    readonly t3Home: string;
  } | null;
  /** Where `system` installs, after an admin prompt when it is not writable. Null where unsupported. */
  readonly systemDirectory: string | null;
  /** Folders an older build of the app linked its command into. Checked, and cleaned up on uninstall. */
  readonly legacyDirectories: ReadonlyArray<string>;
  /** The PATH a new login shell gets. */
  readonly loginPath: Effect.Effect<string>;
  /** Runs `script` with sh as root once the user approves the system's admin prompt. */
  readonly runAsAdmin: (
    script: string,
    prompt: string,
  ) => Effect.Effect<void, DesktopCliCommandError>;
}

type Installed =
  | { readonly kind: "none" }
  | { readonly kind: "foreign" }
  | { readonly kind: "ours"; readonly content: string; readonly app: string | null };

/** The command on macOS and Linux: a marked sh launcher in a folder on PATH. */
export const makeUnix = (host: UnixCliCommandHost) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fail = (message: string) => new DesktopCliCommandError({ message });
    const userDirectory = path.join(host.homeDirectory, ".local", "bin");
    const commandIn = (directory: string) => path.join(directory, DesktopCliShim.COMMAND_NAME);
    const writableDirectory = (directory: string) =>
      fs.access(directory, { writable: true }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

    /** Ours by the marker, read through a link an older build made. Anything else there is foreign. */
    const inspect = (file: string) =>
      Effect.gen(function* () {
        const present = yield* fs.readLink(file).pipe(
          Effect.as(true),
          Effect.catch(() => fs.exists(file)),
          Effect.orElseSucceed(() => false),
        );
        if (!present) return { kind: "none" } as Installed;
        const info = yield* fs.stat(file).pipe(Effect.option);
        if (info._tag === "None" || info.value.type !== "File")
          return { kind: "foreign" } as Installed;
        if (Number(info.value.size) > MAX_SHIM_BYTES) return { kind: "foreign" } as Installed;
        const content = yield* fs.readFileString(file).pipe(Effect.option);
        if (content._tag === "None" || !content.value.includes(DesktopCliShim.MARKER)) {
          return { kind: "foreign" } as Installed;
        }
        return {
          kind: "ours",
          content: content.value,
          app: DesktopCliShim.parseCliShimApp(content.value),
        } as Installed;
      });

    const render = (file: string) =>
      host.shim === null
        ? null
        : DesktopCliShim.renderCliShim({
            target: host.shim.target,
            shimPath: file,
            t3Home: host.shim.t3Home,
          });

    const locations = [
      ...new Set([
        userDirectory,
        ...(host.systemDirectory === null ? [] : [host.systemDirectory]),
        ...host.legacyDirectories,
      ]),
    ];

    const scan = Effect.forEach(locations, (directory) =>
      Effect.map(inspect(commandIn(directory)), (installed) => ({
        directory,
        file: commandIn(directory),
        installed,
      })),
    );

    const state: DesktopCliCommand["Service"]["state"] = Effect.gen(function* () {
      if (host.shim === null) return unsupported;
      const onPath = pathEntries(yield* host.loginPath, ":");
      const found = yield* scan;
      const pathRank = (directory: string) => {
        const index = onPath.indexOf(directory);
        return index === -1 ? Number.POSITIVE_INFINITY : index;
      };
      // Of several of ours, the one a new terminal runs first is the one that counts.
      const installed = found
        .filter((entry) => entry.installed.kind === "ours")
        .toSorted((left, right) => pathRank(left.directory) - pathRank(right.directory))[0];

      let first: { readonly file: string; readonly installed: Installed } | undefined;
      for (const directory of onPath) {
        const file = commandIn(directory);
        const known = found.find((entry) => entry.file === file);
        const entry = known?.installed ?? (yield* inspect(file));
        if (entry.kind !== "none") {
          first = { file, installed: entry };
          break;
        }
      }
      const foreignPath =
        first?.installed.kind === "foreign"
          ? first.file
          : found.find(
              (entry) =>
                entry.installed.kind === "foreign" &&
                (entry.directory === userDirectory || entry.directory === host.systemDirectory),
            )?.file;

      const userDirectoryOnPath = onPath.includes(userDirectory);
      const base = {
        supported: true,
        userDirectory,
        userDirectoryOnPath,
        systemDirectory: host.systemDirectory,
        recommendedLocation:
          userDirectoryOnPath || host.systemDirectory === null
            ? ("user" as const)
            : ("system" as const),
        ...(foreignPath === undefined ? {} : { foreignPath }),
      };
      if (installed === undefined || installed.installed.kind !== "ours") {
        return {
          ...base,
          status: foreignPath === undefined ? "not-installed" : "foreign",
          installedPath: null,
          appPath: null,
          upToDate: true,
          onPath: false,
        } satisfies DesktopCliCommandState;
      }
      const app = installed.installed.app;
      const appExists =
        app !== null && (yield* fs.exists(app).pipe(Effect.orElseSucceed(() => false)));
      return {
        ...base,
        status: appExists ? "installed" : "stale",
        installedPath: installed.file,
        appPath: app === null ? null : appBundleOf(app),
        upToDate: installed.installed.content === render(installed.file),
        onPath: first?.file === installed.file,
      } satisfies DesktopCliCommandState;
    }).pipe(Effect.withSpan("desktop.cliCommand.state"));

    const writeAsUser = (file: string, content: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        // Written beside the command and renamed over it, so a running `cogenly` never reads half a file.
        const staging = `${file}.${process.pid}.tmp`;
        yield* fs.writeFileString(staging, content, { mode: 0o755 });
        yield* fs.chmod(staging, 0o755);
        yield* fs.rename(staging, file);
      }).pipe(Effect.mapError(() => fail(`Could not write ${file}.`)));

    const writeAsAdmin = (file: string, content: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const staging = yield* fs
            .makeTempDirectoryScoped({ prefix: "cogenly-cli-" })
            .pipe(Effect.mapError(() => fail("Could not stage the cogenly command.")));
          const source = path.join(staging, DesktopCliShim.COMMAND_NAME);
          yield* fs
            .writeFileString(source, content)
            .pipe(Effect.mapError(() => fail("Could not stage the cogenly command.")));
          yield* host.runAsAdmin(
            systemInstallScript({ source, destination: file }),
            `Cogenly wants to install the cogenly command in ${path.dirname(file)}.`,
          );
        }),
      );

    const install: DesktopCliCommand["Service"]["install"] = Effect.fn(
      "desktop.cliCommand.install",
    )(function* (input) {
      if (host.shim === null) {
        return yield* fail("The cogenly command needs an installed Cogenly app.");
      }
      const location: DesktopCliCommandLocation =
        input.location ?? (yield* state).recommendedLocation;
      const directory = location === "user" ? userDirectory : host.systemDirectory;
      if (directory === null) {
        return yield* fail("Cogenly installs the cogenly command system-wide only on macOS.");
      }
      const file = commandIn(directory);
      const existing = yield* inspect(file);
      if (existing.kind === "foreign") {
        return yield* fail(
          `${file} was not installed by Cogenly, so it was left alone. Remove it to install Cogenly's.`,
        );
      }
      const content = render(file)!;
      if (existing.kind !== "ours" || existing.content !== content) {
        const asUser =
          location === "user" ||
          ((yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false))) &&
            (yield* writableDirectory(directory)));
        yield* asUser ? writeAsUser(file, content) : writeAsAdmin(file, content);
      }
      return yield* state;
    });

    const uninstall: DesktopCliCommand["Service"]["uninstall"] = Effect.gen(function* () {
      const ours = (yield* scan).filter((entry) => entry.installed.kind === "ours");
      const needsAdmin: Array<string> = [];
      for (const entry of ours) {
        if (yield* writableDirectory(entry.directory)) {
          yield* fs
            .remove(entry.file)
            .pipe(Effect.mapError(() => fail(`Could not remove ${entry.file}.`)));
        } else {
          needsAdmin.push(entry.file);
        }
      }
      if (needsAdmin.length > 0) {
        if (host.systemDirectory === null) {
          return yield* fail(`Could not remove ${needsAdmin.join(", ")}. Remove it with sudo rm.`);
        }
        yield* host.runAsAdmin(
          systemUninstallScript(needsAdmin),
          `Cogenly wants to remove the cogenly command from ${needsAdmin.map((file) => path.dirname(file)).join(", ")}.`,
        );
      }
      return yield* state;
    }).pipe(Effect.withSpan("desktop.cliCommand.uninstall"));

    return DesktopCliCommand.of({ state, install, uninstall });
  });

/**
 * Reads, or with `T3_SET` set writes, the user's PATH in the registry, keeping
 * `%VAR%` entries unexpanded. Writes keep REG_EXPAND_SZ (Windows' default for
 * PATH; `SetEnvironmentVariable` would store REG_SZ and break every `%VAR%`
 * entry), then broadcast WM_SETTINGCHANGE so Explorer and the terminals it
 * opens see the change. A failed read exits nonzero rather than reading as
 * empty, so a write never replaces the user's PATH wholesale.
 */
const WINDOWS_USER_PATH_SCRIPT = `
$ErrorActionPreference = 'Stop'
if ($env:T3_SET -eq '1') {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($key.GetValueNames() -contains 'Path' -and $key.GetValueKind('Path') -eq 'String') {
    $kind = [Microsoft.Win32.RegistryValueKind]::String
  }
  $key.SetValue('Path', $env:T3_PATH, $kind)
  Add-Type -Namespace Cogenly -Name Env -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);'
  $result = [System.UIntPtr]::Zero
  [void][Cogenly.Env]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
} else {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  $value = if ($key) { $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames') } else { '' }
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$value)))
}
`;

/** Windows paths compare without case or a trailing separator. */
const sameWindowsPath = (left: string, right: string) =>
  left.replace(/[\\/]+$/, "").toLowerCase() === right.replace(/[\\/]+$/, "").toLowerCase();

/** The command on Windows: the launcher's folder in the Cogenly home, added to the user's PATH. */
const makeWindows = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = environment.path;
  const launcher = DesktopCliShim.launcherPath(environment);
  const binDirectory = path.dirname(launcher);
  /** Records that Install added `binDirectory` to the Windows PATH, so Remove takes out only that. */
  const ownedPathMarker = path.join(environment.stateDir, "cli-command-path-entry");
  const fail = (message: string) => new DesktopCliCommandError({ message });
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));

  const powershell = (env: Record<string, string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = process.env.SystemRoot ?? process.env.WINDIR;
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : "powershell.exe",
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_USER_PATH_SCRIPT],
            { stdin: "ignore", stderr: "ignore", env, extendEnv: true },
          ),
        );
        const [stdout, exitCode] = yield* Effect.all(
          [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) return yield* Effect.fail(`powershell exited with ${exitCode}`);
        return stdout;
      }),
    );
  const readUserPath = powershell({}).pipe(
    Effect.map((encoded) => Buffer.from(encoded.trim(), "base64").toString("utf8")),
    Effect.mapError(() => fail("Could not read your PATH, so it was left unchanged.")),
  );
  const writeUserPath = (value: string) =>
    powershell({ T3_SET: "1", T3_PATH: value }).pipe(
      Effect.asVoid,
      Effect.mapError(() => fail("Could not update your PATH.")),
    );

  const state: DesktopCliCommand["Service"]["state"] = Effect.gen(function* () {
    if (!environment.isPackaged) return unsupported;
    const installed =
      (yield* exists(ownedPathMarker)) &&
      pathEntries(yield* readUserPath, ";").some((entry) => sameWindowsPath(entry, binDirectory));
    // Only terminals opened after the change see it.
    return {
      supported: true,
      status: installed ? "installed" : "not-installed",
      installedPath: installed ? launcher : null,
      appPath: null,
      upToDate: true,
      onPath: installed,
      userDirectory: binDirectory,
      userDirectoryOnPath: true,
      systemDirectory: null,
      recommendedLocation: "user",
    } satisfies DesktopCliCommandState;
  }).pipe(Effect.orElseSucceed(() => unsupported));

  /** Writes the launcher if the app has not yet, e.g. when no local backend runs. */
  const ensureLauncher = DesktopCliShim.install.pipe(
    Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.flatMap((installed) =>
      installed._tag === "None"
        ? Effect.fail(fail(`Could not set up the cogenly launcher at ${launcher}.`))
        : Effect.void,
    ),
  );

  const install: DesktopCliCommand["Service"]["install"] = Effect.fn("desktop.cliCommand.install")(
    function* (input) {
      if (!environment.isPackaged)
        return yield* fail("The cogenly command needs an installed app.");
      if (input.location === "system") {
        return yield* fail("Cogenly installs the cogenly command system-wide only on macOS.");
      }
      yield* ensureLauncher;
      const entries = pathEntries(yield* readUserPath, ";");
      if (!entries.some((entry) => sameWindowsPath(entry, binDirectory))) {
        yield* writeUserPath([...entries, binDirectory].join(";"));
        yield* fs
          .writeFileString(ownedPathMarker, `${binDirectory}\n`)
          .pipe(Effect.mapError(() => fail("Added cogenly to your PATH but could not record it.")));
      }
      return yield* state;
    },
  );

  const uninstall: DesktopCliCommand["Service"]["uninstall"] = Effect.gen(function* () {
    if (yield* exists(ownedPathMarker)) {
      const entries = pathEntries(yield* readUserPath, ";");
      const kept = entries.filter((entry) => !sameWindowsPath(entry, binDirectory));
      if (kept.length !== entries.length) yield* writeUserPath(kept.join(";"));
      yield* fs.remove(ownedPathMarker).pipe(Effect.ignore);
    }
    return yield* state;
  }).pipe(Effect.withSpan("desktop.cliCommand.uninstall"));

  return DesktopCliCommand.of({ state, install, uninstall });
});

/** Runs a script as root through macOS's own admin prompt; a cancelled prompt changes nothing. */
const runAsMacAdmin =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  (script: string, prompt: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("/usr/bin/osascript", ["-e", appleScriptAdminCommand(script, prompt)], {
            stdin: "ignore",
            stdout: "ignore",
          }),
        );
        const [stderr, exitCode] = yield* Effect.all(
          [handle.stderr.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return { stderr, exitCode };
      }),
    ).pipe(
      Effect.mapError(
        () => new DesktopCliCommandError({ message: "Could not ask for admin rights." }),
      ),
      Effect.flatMap(({ stderr, exitCode }) => {
        if (exitCode === 0) return Effect.void;
        // osascript reports a cancelled prompt as error -128, and a script failure as "execution error: <stderr> (<code>)".
        const message = stderr.includes("(-128)")
          ? "The admin prompt was cancelled, so nothing changed."
          : (/execution error: ([\s\S]*?) \(\d+\)\s*$/.exec(stderr.trim())?.[1] ??
            "The admin step failed, so nothing changed.");
        return Effect.fail(new DesktopCliCommandError({ message }));
      }),
    );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.platform === "win32") return yield* makeWindows;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
  const darwin = environment.platform === "darwin";
  const home = environment.homeDirectory;
  return yield* makeUnix({
    homeDirectory: home,
    shim: environment.isPackaged
      ? {
          target: DesktopCliShim.resolveCliShimTarget(environment),
          t3Home: environment.baseDir,
        }
      : null,
    systemDirectory: darwin ? "/usr/local/bin" : null,
    legacyDirectories: darwin ? ["/opt/homebrew/bin", `${home}/bin`] : [`${home}/bin`],
    // The login shell's PATH, which the app merges into its own before it starts the backend.
    loginPath: shellEnvironment.installIntoProcess.pipe(Effect.map(() => process.env.PATH ?? "")),
    runAsAdmin: darwin
      ? runAsMacAdmin(spawner)
      : () =>
          Effect.fail(
            new DesktopCliCommandError({ message: "Cogenly asks for admin rights only on macOS." }),
          ),
  });
});

export const layer = Layer.effect(DesktopCliCommand, make);

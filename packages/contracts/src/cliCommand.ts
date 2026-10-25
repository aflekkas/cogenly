import * as Schema from "effect/Schema";

/**
 * Where the desktop app installs the `cogenly` command: `user` is `~/.local/bin`,
 * no admin rights needed. `system` is `/usr/local/bin` on macOS, after the
 * system's administrator prompt.
 */
export const DesktopCliCommandLocation = Schema.Literals(["user", "system"]);
export type DesktopCliCommandLocation = typeof DesktopCliCommandLocation.Type;

/** The desktop app's `cogenly` command on PATH, managed from Settings, the command palette, or an agent. */
export const DesktopCliCommandStateSchema = Schema.Struct({
  /** Only installed macOS, Linux, and Windows builds have a CLI to put on PATH. */
  supported: Schema.Boolean,
  /**
   * `installed`: the app's command is there and its app exists. `stale`: it is the
   * app's, but the app it runs has moved or been removed. `foreign`: none of the
   * app's is installed, and a `cogenly` the app did not write is in the way.
   */
  status: Schema.Literals(["not-installed", "installed", "stale", "foreign"]),
  /** The `cogenly` the app installed, or null when none is. */
  installedPath: Schema.NullOr(Schema.String),
  /** The app the installed command runs, such as `/Applications/Cogenly.app`. */
  appPath: Schema.NullOr(Schema.String),
  /** False when the installed command runs another app or home than this one; Install updates it. */
  upToDate: Schema.Boolean,
  /** Whether a new terminal runs it: its folder is on the login shell's PATH and nothing else shadows it. */
  onPath: Schema.Boolean,
  /** A `cogenly` the app did not write: at an install location, or earlier on PATH. Never overwritten. */
  foreignPath: Schema.optionalKey(Schema.String),
  /**
   * Where `user` installs (`~/.local/bin`), and whether the login shell has it on
   * PATH. On Windows it is the launcher's folder, which Install adds to PATH itself.
   */
  userDirectory: Schema.NullOr(Schema.String),
  userDirectoryOnPath: Schema.Boolean,
  /** Where `system` installs (`/usr/local/bin`), or null where the app cannot install there. */
  systemDirectory: Schema.NullOr(Schema.String),
  /** The location Install uses when none is given: `user` when it is on PATH, else `system` where available. */
  recommendedLocation: DesktopCliCommandLocation,
});
export type DesktopCliCommandState = typeof DesktopCliCommandStateSchema.Type;

export const DesktopCliCommandInstallInput = Schema.Struct({
  location: Schema.optionalKey(DesktopCliCommandLocation),
});
export type DesktopCliCommandInstallInput = typeof DesktopCliCommandInstallInput.Type;

/** An install or uninstall, with the state after it. A refusal or a cancelled admin prompt is `ok: false`. */
export const DesktopCliCommandChangeResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), state: DesktopCliCommandStateSchema }),
  Schema.Struct({
    ok: Schema.Literal(false),
    message: Schema.String,
    state: DesktopCliCommandStateSchema,
  }),
]);
export type DesktopCliCommandChangeResult = typeof DesktopCliCommandChangeResult.Type;

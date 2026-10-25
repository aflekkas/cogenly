import type { DesktopCliCommandState } from "@cogenly/contracts";

import { cliCommandDirectory, useDesktopCliCommand } from "../../desktopCliCommand";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function describe(state: DesktopCliCommandState): string {
  const runs = state.appPath ? `, which runs ${state.appPath}` : "";
  switch (state.status) {
    case "stale":
      return `${state.installedPath}${runs}, which has moved or been removed. Update it to run this app.`;
    case "foreign":
      return `${state.foreignPath} is a cogenly command Cogenly did not install, so Cogenly leaves it alone.`;
    case "not-installed":
      return !state.userDirectoryOnPath && state.systemDirectory !== null
        ? `Run Cogenly's CLI as \`cogenly\` from any terminal. ${state.userDirectory} is not on your PATH, so install to ${state.systemDirectory}, which asks for your password.`
        : !state.userDirectoryOnPath
          ? `Run Cogenly's CLI as \`cogenly\` from any terminal. Add ${state.userDirectory} to your PATH after installing.`
          : "Run Cogenly's CLI as `cogenly` from any terminal.";
    case "installed":
      if (!state.upToDate) {
        return `Installed at ${state.installedPath}${runs}. Update it to run this app.`;
      }
      if (state.onPath) return `Installed at ${state.installedPath}${runs}.`;
      return state.foreignPath
        ? `Installed at ${state.installedPath}, but ${state.foreignPath} runs first in a new terminal. Remove that one to use Cogenly's.`
        : `Installed at ${state.installedPath}, which is not on your PATH. Add its folder to your PATH${state.systemDirectory === null ? "" : `, or install to ${state.systemDirectory}`}.`;
  }
}

/**
 * Settings → `cogenly` command: puts the desktop app's bundled CLI on PATH, or
 * takes it off again. Hidden outside the desktop app and in builds with no CLI.
 */
export function CliCommandSettingsRow() {
  const cliCommand = useDesktopCliCommand();
  if (cliCommand === null) return null;
  const { state, pending, change } = cliCommand;
  const installed = state.installedPath !== null;
  // A user folder off PATH leaves the choice to the user: the system folder asks for a password.
  const offerSystem =
    state.systemDirectory !== null &&
    !state.userDirectoryOnPath &&
    state.installedPath !== `${state.systemDirectory}/cogenly`;
  const needsUpdate = state.status === "stale" || (installed && !state.upToDate);

  return (
    <SettingsRow
      {...searchableSetting("cli-command")}
      description={describe(state)}
      control={
        <div className="flex flex-wrap justify-end gap-2">
          {needsUpdate ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => change("install")}
            >
              Update
            </Button>
          ) : null}
          {!installed && !offerSystem ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => change("install")}
            >
              Install
            </Button>
          ) : null}
          {!installed && offerSystem ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => change("install", "user")}
            >
              Install to {cliCommandDirectory(state, "user")}
            </Button>
          ) : null}
          {offerSystem && (!installed || !state.onPath) ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => change("install", "system")}
            >
              Install to {cliCommandDirectory(state, "system")}…
            </Button>
          ) : null}
          {installed ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => change("uninstall")}
            >
              Uninstall
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

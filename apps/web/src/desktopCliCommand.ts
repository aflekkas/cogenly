import type {
  DesktopCliCommandChangeResult,
  DesktopCliCommandLocation,
  DesktopCliCommandState,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { stackedThreadToast, toastManager } from "./components/ui/toast";

/** The folder a location installs to, as the user reads it. */
export function cliCommandDirectory(
  state: DesktopCliCommandState,
  location: DesktopCliCommandLocation,
): string {
  return (location === "system" ? state.systemDirectory : state.userDirectory) ?? "";
}

/** What a toast says after a change went through. */
function changedMessage(state: DesktopCliCommandState): string {
  if (state.installedPath === null) return "Removed the cogenly command.";
  if (state.onPath)
    return `Installed cogenly at ${state.installedPath}. Open a new terminal to use it.`;
  return state.foreignPath
    ? `Installed cogenly at ${state.installedPath}, but ${state.foreignPath} runs first in a new terminal.`
    : `Installed cogenly at ${state.installedPath}. Add its folder to your PATH to run it.`;
}

/**
 * The desktop app's `cogenly` command, for Settings and the command palette:
 * its state, and install or uninstall with a toast for the outcome. Null
 * outside the desktop app, or in a desktop build that has no CLI to install.
 */
export function useDesktopCliCommand() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.cliCommand;
  const [state, setState] = useState<DesktopCliCommandState | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge
      .getState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const change = useCallback(
    async (action: "install" | "uninstall", location?: DesktopCliCommandLocation) => {
      if (!bridge || pending) return;
      setPending(true);
      try {
        const result: DesktopCliCommandChangeResult =
          action === "install"
            ? await bridge.install(location === undefined ? {} : { location })
            : await bridge.uninstall();
        setState(result.state);
        toastManager.add(
          result.ok
            ? { type: "success", title: changedMessage(result.state) }
            : stackedThreadToast({
                type: "error",
                title:
                  action === "install" ? "Could not install cogenly" : "Could not remove cogenly",
                description: result.message,
              }),
        );
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: action === "install" ? "Could not install cogenly" : "Could not remove cogenly",
            description: error instanceof Error ? error.message : "Something went wrong.",
          }),
        );
      } finally {
        setPending(false);
      }
    },
    [bridge, pending],
  );

  if (!bridge || !state?.supported) return null;
  return { state, pending, change };
}

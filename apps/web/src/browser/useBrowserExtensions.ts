import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import type { BrowserExtension, EnvironmentId } from "@cogenly/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  browserExtensionErrorMessage,
  browserExtensionInstalledMessage,
  browserExtensionReinstallSource,
} from "./browserExtensions.logic";

/** An install's outcome: null when it worked, otherwise what to tell the user. */
export type BrowserExtensionInstall = (source: string) => Promise<string | null>;

/**
 * One profile's extensions on one environment, which owns the list. Nothing is
 * cached across mounts: callers `reload` when they show the list, so it reflects
 * what an agent or another client changed since.
 */
export function useBrowserExtensions(environmentId: EnvironmentId | null, profileId: string) {
  const canManage = useAtomValue(previewEnvironment.extensionsList.permissionAtom(environmentId));
  const runList = useAtomCommand(previewEnvironment.extensionsList, { reportFailure: false });
  const runInstall = useAtomCommand(previewEnvironment.extensionInstall, { reportFailure: false });
  const runRemove = useAtomCommand(previewEnvironment.extensionRemove, { reportFailure: false });
  const runToggle = useAtomCommand(previewEnvironment.extensionToggle, { reportFailure: false });
  const key = JSON.stringify([environmentId, profileId]);
  // Results land only for the profile they were asked for.
  const keyRef = useRef(key);
  useLayoutEffect(() => {
    keyRef.current = key;
  }, [key]);
  const [state, setState] = useState<{
    readonly key: string;
    readonly extensions: ReadonlyArray<BrowserExtension>;
  } | null>(null);
  const [loadError, setLoadError] = useState<{ key: string; message: string } | null>(null);
  const extensions = state?.key === key ? state.extensions : null;

  const commit = useCallback(
    (
      forKey: string,
      update: (current: ReadonlyArray<BrowserExtension>) => ReadonlyArray<BrowserExtension>,
    ) => {
      if (forKey !== keyRef.current) return;
      setState((previous) => ({
        key: forKey,
        extensions: update(previous?.key === forKey ? previous.extensions : []),
      }));
    },
    [],
  );

  const reload = useCallback(async () => {
    if (!environmentId || !canManage) return;
    const forKey = key;
    const result = await runList({ environmentId, input: { profileId } });
    if (forKey !== keyRef.current || isAtomCommandInterrupted(result)) return;
    if (result._tag === "Success") {
      setLoadError(null);
      commit(forKey, () => result.value.extensions);
    } else {
      setLoadError({
        key: forKey,
        message: browserExtensionErrorMessage(
          squashAtomCommandFailure(result),
          "Could not read this profile's extensions.",
        ),
      });
    }
  }, [canManage, commit, environmentId, key, profileId, runList]);

  const install: BrowserExtensionInstall = useCallback(
    async (source) => {
      if (!environmentId) return "Connect to a machine to install extensions.";
      const forKey = key;
      const result = await runInstall({ environmentId, input: { profileId, source } });
      if (result._tag === "Failure") {
        return browserExtensionErrorMessage(
          squashAtomCommandFailure(result),
          "Could not install the extension.",
        );
      }
      const installed = result.value.extension;
      commit(forKey, (current) =>
        current.some((extension) => extension.id === installed.id)
          ? current.map((extension) => (extension.id === installed.id ? installed : extension))
          : [...current, installed],
      );
      toastManager.add({ type: "success", title: browserExtensionInstalledMessage(result.value) });
      return null;
    },
    [commit, environmentId, key, profileId, runInstall],
  );

  const setEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      if (!environmentId) return;
      const forKey = key;
      const swap = (next: boolean) =>
        commit(forKey, (current) =>
          current.map((extension) =>
            extension.id === id ? { ...extension, enabled: next } : extension,
          ),
        );
      // The switch moves now; a refusal moves it back.
      swap(enabled);
      const result = await runToggle({ environmentId, input: { profileId, id, enabled } });
      if (result._tag === "Success") {
        const updated = result.value;
        commit(forKey, (current) =>
          current.map((extension) => (extension.id === id ? updated : extension)),
        );
        return;
      }
      swap(!enabled);
      if (isAtomCommandInterrupted(result)) return;
      toastManager.add({
        type: "error",
        title: enabled ? "Could not turn on the extension" : "Could not turn off the extension",
        description: browserExtensionErrorMessage(
          squashAtomCommandFailure(result),
          "An error occurred.",
        ),
      });
    },
    [commit, environmentId, key, profileId, runToggle],
  );

  const remove = useCallback(
    async (extension: BrowserExtension) => {
      if (!environmentId) return;
      const forKey = key;
      const result = await runRemove({ environmentId, input: { profileId, id: extension.id } });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        toastManager.add({
          type: "error",
          title: `Could not remove ${extension.name}`,
          description: browserExtensionErrorMessage(
            squashAtomCommandFailure(result),
            "An error occurred.",
          ),
        });
        return;
      }
      commit(forKey, () => result.value.extensions);
      // Removal asks nothing first; the way back is one click here.
      const toastId = toastManager.add({
        type: "success",
        title: `Removed ${extension.name}`,
        actionProps: {
          children: "Reinstall",
          onClick: () => {
            toastManager.close(toastId);
            void install(browserExtensionReinstallSource(extension)).then((error) => {
              if (error) {
                toastManager.add({
                  type: "error",
                  title: `Could not reinstall ${extension.name}`,
                  description: error,
                });
              }
            });
          },
        },
      });
    },
    [commit, environmentId, install, key, profileId, runRemove],
  );

  return {
    canManage: environmentId !== null && canManage,
    /** Null until the first list for this environment and profile arrives. */
    extensions,
    loadError: loadError?.key === key ? loadError.message : null,
    reload,
    install,
    setEnabled,
    remove,
  };
}

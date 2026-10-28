import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import type { BrowserExtension, EnvironmentId } from "@cogenly/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useMemo, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  browserExtensionErrorMessage,
  browserExtensionInstalledMessage,
  browserExtensionReinstallSource,
} from "./browserExtensions.logic";

/** An install's outcome: null when it worked, otherwise what to tell the user. */
export type BrowserExtensionInstall = (source: string) => Promise<string | null>;

/**
 * One profile's extensions on one environment, which owns the list. The list
 * follows the environment live, so it shows what an agent, another client, or
 * the browser's own load results changed since. Every caller for the same
 * profile shares one subscription.
 */
export function useBrowserExtensionList(environmentId: EnvironmentId | null, profileId: string) {
  const canManage = useAtomValue(previewEnvironment.extensionsList.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    environmentId !== null && canManage
      ? previewEnvironment.extensionsSubscribe({ environmentId, input: { profileId } })
      : null,
  );
  return {
    canManage: environmentId !== null && canManage,
    /** Null until the first list for this environment and profile arrives. */
    extensions: query.data?.extensions ?? null,
    loadError:
      query.data === null && query.failure !== null
        ? browserExtensionErrorMessage(query.failure, "Could not read this profile's extensions.")
        : null,
  };
}

/** The list with the actions that change it. */
export function useBrowserExtensions(environmentId: EnvironmentId | null, profileId: string) {
  const list = useBrowserExtensionList(environmentId, profileId);
  const runInstall = useAtomCommand(previewEnvironment.extensionInstall, { reportFailure: false });
  const runRemove = useAtomCommand(previewEnvironment.extensionRemove, { reportFailure: false });
  const runToggle = useAtomCommand(previewEnvironment.extensionToggle, { reportFailure: false });
  const runReload = useAtomCommand(previewEnvironment.extensionReload, { reportFailure: false });
  // A switch moves on click and holds until the live list agrees or the change fails.
  const [pendingEnabled, setPendingEnabled] = useState<Readonly<Record<string, boolean>>>({});
  const [listSeen, setListSeen] = useState(list.extensions);
  // Settled when the live list catches up, checked as each new list renders.
  if (listSeen !== list.extensions && list.extensions) {
    setListSeen(list.extensions);
    const settled = new Map(list.extensions.map((extension) => [extension.id, extension.enabled]));
    const kept = Object.entries(pendingEnabled).filter(
      ([id, enabled]) => settled.has(id) && settled.get(id) !== enabled,
    );
    if (kept.length !== Object.keys(pendingEnabled).length) {
      setPendingEnabled(Object.fromEntries(kept));
    }
  }

  const extensions = useMemo(
    () =>
      list.extensions?.map((extension) => {
        const enabled = pendingEnabled[extension.id];
        return enabled === undefined || enabled === extension.enabled
          ? extension
          : { ...extension, enabled };
      }) ?? null,
    [list.extensions, pendingEnabled],
  );

  const install: BrowserExtensionInstall = useCallback(
    async (source) => {
      if (!environmentId) return "Connect to a machine to install extensions.";
      const result = await runInstall({ environmentId, input: { profileId, source } });
      if (result._tag === "Failure") {
        return browserExtensionErrorMessage(
          squashAtomCommandFailure(result),
          "Could not install the extension.",
        );
      }
      toastManager.add({ type: "success", title: browserExtensionInstalledMessage(result.value) });
      return null;
    },
    [environmentId, profileId, runInstall],
  );

  const setEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      if (!environmentId) return;
      setPendingEnabled((current) => ({ ...current, [id]: enabled }));
      const result = await runToggle({ environmentId, input: { profileId, id, enabled } });
      if (result._tag === "Success") return;
      setPendingEnabled(({ [id]: _failed, ...rest }) => rest);
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
    [environmentId, profileId, runToggle],
  );

  /** Reads an unpacked extension's folder again, after its files changed. */
  const reloadFromFolder = useCallback(
    async (extension: BrowserExtension) => {
      if (!environmentId) return;
      const result = await runReload({ environmentId, input: { profileId, id: extension.id } });
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: browserExtensionInstalledMessage(result.value),
        });
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      toastManager.add({
        type: "error",
        title: `Could not reload ${extension.name}`,
        description: browserExtensionErrorMessage(
          squashAtomCommandFailure(result),
          "An error occurred.",
        ),
      });
    },
    [environmentId, profileId, runReload],
  );

  const remove = useCallback(
    async (extension: BrowserExtension) => {
      if (!environmentId) return;
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
    [environmentId, install, profileId, runRemove],
  );

  return {
    canManage: list.canManage,
    extensions,
    loadError: list.loadError,
    install,
    setEnabled,
    reloadFromFolder,
    remove,
  };
}

export type BrowserExtensionActions = ReturnType<typeof useBrowserExtensions>;

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import type {
  BrowserExtension,
  EnvironmentId,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@cogenly/contracts";
import { useCallback } from "react";

import { browserExtensionErrorMessage } from "~/browser/browserExtensions.logic";
import { toastManager } from "~/components/ui/toast";
import {
  beginPreviewSessionClose,
  cancelPreviewSessionClose,
  readThreadPreviewState,
  selectExtensionSurfaces,
} from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

/**
 * Per environment and profile, the extension whose side panel opened last:
 * the one the keybinding toggles. Each machine has its own extensions.
 */
const recentSidePanelByProfile = new Map<string, string>();

const profileKey = (environmentId: EnvironmentId, profileId: string) =>
  `${environmentId}\u0000${profileId}`;

export const recentSidePanelExtensionId = (environmentId: EnvironmentId, profileId: string) =>
  recentSidePanelByProfile.get(profileKey(environmentId, profileId)) ?? null;

/**
 * Opens and closes an extension's popup and side panel on a host tab. Both are
 * server tabs the panel draws beside the host; a host holds at most one of
 * each, so opening another closes the one before. `open` resolves to the
 * surface's tab, or null when it opened none.
 */
export function useExtensionSurfaceActions(threadRef: ScopedThreadRef, profileId: string) {
  const runOpen = useAtomCommand(previewEnvironment.extensionOpenSurface, { reportFailure: false });
  const runClose = useAtomCommand(previewEnvironment.close, "preview close");

  const close = useCallback(
    async (snapshot: PreviewSessionSnapshot) => {
      // Not a closed tab to reopen later, so it skips the closed-view history.
      beginPreviewSessionClose(threadRef, snapshot.tabId);
      const result = await runClose({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, tabId: snapshot.tabId },
      });
      if (result._tag === "Failure") cancelPreviewSessionClose(threadRef, snapshot, snapshot.tabId);
    },
    [runClose, threadRef],
  );

  const open = useCallback(
    async (extension: BrowserExtension, kind: "popup" | "sidePanel", hostTabId: string) => {
      const existing = selectExtensionSurfaces(
        readThreadPreviewState(threadRef).sessions,
        hostTabId,
      )[kind];
      if (existing) void close(existing);
      if (kind === "sidePanel") {
        recentSidePanelByProfile.set(profileKey(threadRef.environmentId, profileId), extension.id);
      }
      const result = await runOpen({
        environmentId: threadRef.environmentId,
        input: {
          profileId,
          id: extension.id,
          // An action without a popup runs its click handler and opens nothing.
          kind: kind === "popup" && !extension.popupPage ? "action" : kind,
          hostTabId,
          threadId: threadRef.threadId,
        },
      });
      if (result._tag === "Success") return result.value.surfaceTabId ?? null;
      if (isAtomCommandInterrupted(result)) return null;
      toastManager.add({
        type: "error",
        title:
          kind === "popup"
            ? `Could not open ${extension.name}`
            : `Could not open ${extension.name}'s side panel`,
        description: browserExtensionErrorMessage(
          squashAtomCommandFailure(result),
          "An error occurred.",
        ),
      });
      return null;
    },
    [close, profileId, runOpen, threadRef],
  );

  return { open, close };
}

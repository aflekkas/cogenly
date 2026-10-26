import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@cogenly/client-runtime/state/runtime";
import type { PreviewRuntime, ScopedThreadRef } from "@cogenly/contracts";

import type { BrowserSettingsReadError, OpenPreviewMutation } from "~/browser/openFileInPreview";
import { useRightPanelStore } from "~/rightPanelStore";

import { openPreviewSession } from "./openPreviewSession";

/** Creates a new browser tab. Reopening an existing tab is a separate UI action. */
export async function addBrowserSurface<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  /** Omit to use the configured default profile. */
  readonly profileId?: string | undefined;
  /** Omit to open a blank tab. */
  readonly url?: string | undefined;
  /** Omit to run where this client runs new tabs. */
  readonly runtime?: PreviewRuntime | undefined;
}): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
    ...(input.url === undefined ? {} : { url: input.url }),
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
  });
  return mapAtomCommandResult(result, (snapshot) => {
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}

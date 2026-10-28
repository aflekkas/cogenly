import type { ScopedThreadRef } from "@cogenly/contracts";

import {
  isExtensionSurface,
  readThreadPreviewState,
  whenPreviewTabKnown,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

/**
 * Switches the viewer to a tab the page they drive just opened, as a browser
 * does for a link click or `window.open`: it becomes the panel's active tab.
 * The opener stays open. An extension's popup or side panel stays beside its
 * host tab instead.
 */
export function showPreviewPopup(threadRef: ScopedThreadRef, popupTabId: string): void {
  whenPreviewTabKnown(threadRef, popupTabId, () => {
    if (isExtensionSurface(readThreadPreviewState(threadRef).sessions[popupTabId])) return;
    useRightPanelStore.getState().openBrowser(threadRef, popupTabId);
  });
}

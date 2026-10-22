import type { ScopedThreadRef } from "@t3tools/contracts";

import { whenPreviewTabKnown } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

/**
 * Switches the viewer to a tab the page they drive just opened, as a browser
 * does for a link click or `window.open`: it becomes the panel's active tab.
 * The opener stays open.
 */
export function showPreviewPopup(threadRef: ScopedThreadRef, popupTabId: string): void {
  whenPreviewTabKnown(threadRef, popupTabId, () => {
    useRightPanelStore.getState().openBrowser(threadRef, popupTabId);
  });
}

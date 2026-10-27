import type { PreviewSessionSnapshot, ScopedThreadRef } from "@cogenly/contracts";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { useRendersServerTabNatively } from "~/browser/previewRuntime";
import { ServerBrowserSurface } from "~/browser/ServerBrowserSurface";
import { useThreadPreviewState } from "~/previewStateStore";

import { showPreviewPopup } from "../showPreviewPopup";

/**
 * The page of an extension's popup or side panel: its server tab, streamed, or
 * drawn by the desktop app's own webview when the server renders it natively.
 * Fills its parent, which sets the size.
 */
export function ExtensionSurface(props: {
  readonly threadRef: ScopedThreadRef;
  readonly snapshot: PreviewSessionSnapshot;
  readonly visible: boolean;
}) {
  const { threadRef, snapshot } = props;
  const serverEpoch = useThreadPreviewState(threadRef).serverEpoch;
  const native = useRendersServerTabNatively(threadRef.environmentId, snapshot);
  const runtimeTabId = previewRuntimeTabId(threadRef, serverEpoch, snapshot.tabId);
  return native ? (
    <BrowserSurfaceSlot
      key={runtimeTabId}
      tabId={runtimeTabId}
      visible={props.visible}
      className="absolute inset-0"
    />
  ) : (
    <ServerBrowserSurface
      key={runtimeTabId}
      environmentId={threadRef.environmentId}
      threadId={threadRef.threadId}
      tabId={snapshot.tabId}
      visible={props.visible}
      // A link the extension opens lands as a tab of its own, like a browser's.
      onPopup={(popupTabId) => showPreviewPopup(threadRef, popupTabId)}
      className="absolute inset-0 h-full w-full"
    />
  );
}

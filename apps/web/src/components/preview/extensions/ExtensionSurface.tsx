import type { PreviewSessionSnapshot, ScopedThreadRef } from "@cogenly/contracts";

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { ServerBrowserSurface } from "~/browser/ServerBrowserSurface";
import { useThreadPreviewState } from "~/previewStateStore";

import { showPreviewPopup } from "../showPreviewPopup";

/**
 * The page of an extension's popup or side panel: its server tab, streamed.
 * Surfaces always stream, even in the desktop app, which never draws them
 * with a webview of its own (ElectronBrowserHost skips them). Fills its
 * parent, which sets the size.
 */
export function ExtensionSurface(props: {
  readonly threadRef: ScopedThreadRef;
  readonly snapshot: PreviewSessionSnapshot;
  readonly visible: boolean;
}) {
  const { threadRef, snapshot } = props;
  const serverEpoch = useThreadPreviewState(threadRef).serverEpoch;
  return (
    <ServerBrowserSurface
      key={previewRuntimeTabId(threadRef, serverEpoch, snapshot.tabId)}
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

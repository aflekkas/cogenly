import type { ThreadId } from "@t3tools/contracts";

export interface NativeServerTab {
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly runtimeTabId: string;
}

/** The native server tabs on screen: their webview is presented visibly, with a place to draw. */
export function shownNativeServerTabs(
  tabs: ReadonlyArray<NativeServerTab>,
  presentations: Readonly<
    Record<string, { readonly visible: boolean; readonly rect: unknown } | undefined>
  >,
): ReadonlyArray<{ readonly threadId: ThreadId; readonly tabId: string }> {
  return tabs
    .filter((tab) => {
      const presentation = presentations[tab.runtimeTabId];
      return presentation?.visible === true && presentation.rect !== null;
    })
    .map(({ threadId, tabId }) => ({ threadId, tabId }));
}

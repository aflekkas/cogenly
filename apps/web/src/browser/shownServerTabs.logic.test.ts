import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shownNativeServerTabs } from "./shownServerTabs.logic";

const threadId = ThreadId.make("thread-1");
const rect = { x: 0, y: 0, width: 800, height: 600 };

describe("shownNativeServerTabs", () => {
  it("reports only the tab whose webview the panel presents on screen", () => {
    // Every tab of an open thread keeps a webview, so being rendered is not being shown.
    const tabs = [
      { threadId, tabId: "grok", runtimeTabId: "runtime-grok" },
      { threadId, tabId: "x-login", runtimeTabId: "runtime-x" },
      { threadId, tabId: "unplaced", runtimeTabId: "runtime-unplaced" },
    ];
    expect(
      shownNativeServerTabs(tabs, {
        "runtime-grok": { visible: true, rect },
        "runtime-x": { visible: false, rect },
        "runtime-unplaced": { visible: true, rect: null },
      }),
    ).toEqual([{ threadId, tabId: "grok" }]);
  });
});

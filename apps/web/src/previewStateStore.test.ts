import {
  EnvironmentId,
  type PreviewEvent,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
  ThreadId,
} from "@cogenly/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  applyPreviewServerEvent,
  beginPreviewSessionClose,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
  selectExtensionSurfaces,
  setActivePreviewTab,
} from "./previewStateStore";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};
const extensionId = "a".repeat(32);
let revision = 0;

const tab = (
  tabId: string,
  updatedAt: string,
  extensionSurface?: PreviewSessionSnapshot["extensionSurface"],
): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: {
    _tag: "Success",
    url: extensionSurface
      ? `chrome-extension://${extensionId}/popup.html`
      : `https://example.com/${tabId}`,
    title: tabId,
  },
  canGoBack: false,
  canGoForward: false,
  runtime: "server",
  updatedAt,
  ...(extensionSurface ? { extensionSurface } : {}),
});

const opened = (snapshot: PreviewSessionSnapshot) => {
  const event: PreviewEvent = {
    type: "opened",
    threadId: threadRef.threadId,
    tabId: snapshot.tabId,
    createdAt: snapshot.updatedAt,
    serverEpoch: "epoch",
    revision: ++revision,
    snapshot,
  };
  applyPreviewServerEvent(threadRef, event);
};

const listed = (sessions: ReadonlyArray<PreviewSessionSnapshot>) =>
  reconcilePreviewServerSessions(threadRef, {
    sessions,
    serverEpoch: "epoch",
    revision: ++revision,
  });

const host = tab("host", "2026-10-27T00:00:01.000Z");
const popup = tab("popup", "2026-10-27T00:00:02.000Z", {
  kind: "popup",
  extensionId,
  hostTabId: "host",
});
const sidePanel = tab("panel", "2026-10-27T00:00:03.000Z", {
  kind: "sidePanel",
  extensionId,
  hostTabId: "host",
});

afterEach(() => {
  resetPreviewStateForTests();
  revision = 0;
});

describe("extension surfaces in the preview state", () => {
  it("shows a popup and side panel an agent opened on their host without switching tabs", () => {
    opened(host);
    opened(popup);
    opened(sidePanel);
    const state = readThreadPreviewState(threadRef);
    expect(state.activeTabId).toBe("host");
    expect(state.recentlySeenUrls).toEqual(["https://example.com/host"]);
    const surfaces = selectExtensionSurfaces(state.sessions, "host");
    expect(surfaces.popup?.tabId).toBe("popup");
    expect(surfaces.sidePanel?.tabId).toBe("panel");
    expect(selectExtensionSurfaces(state.sessions, "other")).toEqual({
      popup: null,
      sidePanel: null,
    });
  });

  it("never makes a surface the active tab", () => {
    opened(host);
    opened(popup);
    setActivePreviewTab(threadRef, "popup");
    expect(readThreadPreviewState(threadRef).activeTabId).toBe("host");
    listed([popup, host]);
    expect(readThreadPreviewState(threadRef).activeTabId).toBe("host");
  });

  it("drops a host's surfaces when the host closes", () => {
    opened(host);
    const other = tab("other", "2026-10-27T00:00:00.000Z");
    opened(other);
    setActivePreviewTab(threadRef, "host");
    opened(popup);
    opened(sidePanel);
    beginPreviewSessionClose(threadRef, "host");
    const state = readThreadPreviewState(threadRef);
    expect(Object.keys(state.sessions)).toEqual(["other"]);
    expect(state.activeTabId).toBe("other");
  });

  it("ignores a surface whose host is gone, from an event or a list", () => {
    opened(popup);
    expect(readThreadPreviewState(threadRef).sessions).toEqual({});
    listed([sidePanel]);
    const state = readThreadPreviewState(threadRef);
    expect(state.sessions).toEqual({});
    expect(state.activeTabId).toBeNull();
  });
});

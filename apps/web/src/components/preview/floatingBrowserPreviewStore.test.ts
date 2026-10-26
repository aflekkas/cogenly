import { EnvironmentId, ThreadId } from "@cogenly/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { migratePersistedFloatingPreview } from "./floatingBrowserPreview.logic";
import {
  selectFloatingPreviewDismissed,
  selectFloatingPreviewTarget,
  showBrowserTabInPanel,
  useFloatingBrowserPreviewStore,
} from "./floatingBrowserPreviewStore";

const environmentId = EnvironmentId.make("env-1");
const curtains = { environmentId, threadId: ThreadId.make("thread-curtains") };
const vault = { environmentId, threadId: ThreadId.make("thread-vault") };
const noTab = { environmentId, threadId: ThreadId.make("thread-no-tab") };
const elsewhere = { environmentId: EnvironmentId.make("env-2"), threadId: curtains.threadId };

const targetOf = (threadRef: typeof curtains) =>
  selectFloatingPreviewTarget(useFloatingBrowserPreviewStore.getState(), threadRef);
const dismissedIn = (threadRef: typeof curtains) =>
  selectFloatingPreviewDismissed(useFloatingBrowserPreviewStore.getState(), threadRef);

beforeEach(() => {
  useFloatingBrowserPreviewStore.setState({ targets: {}, shownCounts: {}, dismissedThreads: {} });
});

describe("floating preview targets", () => {
  it("floats each thread's own tab, and nothing in a thread whose panel showed none", () => {
    showBrowserTabInPanel(curtains, "amazon")();
    showBrowserTabInPanel(vault, "docs")();

    expect(targetOf(curtains)?.tabId).toBe("amazon");
    expect(targetOf(vault)?.tabId).toBe("docs");
    expect(targetOf(noTab)).toBeNull();
    // The same thread id in another environment is another thread.
    expect(targetOf(elsewhere)).toBeNull();
  });

  it("follows the tab a thread's panel showed last, without touching other threads", () => {
    showBrowserTabInPanel(curtains, "amazon")();
    showBrowserTabInPanel(vault, "docs")();
    showBrowserTabInPanel(curtains, "ikea")();

    expect(targetOf(curtains)?.tabId).toBe("ikea");
    expect(targetOf(vault)?.tabId).toBe("docs");
  });

  it("counts the tab as shown only while a panel holds it", () => {
    const release = showBrowserTabInPanel(curtains, "amazon");
    const key = targetOf(curtains)?.key ?? "";
    expect(useFloatingBrowserPreviewStore.getState().shownCounts[key]).toBe(1);
    release();
    release();
    expect(useFloatingBrowserPreviewStore.getState().shownCounts[key]).toBeUndefined();
  });
});

describe("floating preview dismissal", () => {
  it("closes only the thread whose x was pressed", () => {
    showBrowserTabInPanel(curtains, "amazon")();
    showBrowserTabInPanel(vault, "docs")();
    useFloatingBrowserPreviewStore.getState().dismiss(curtains);

    expect(dismissedIn(curtains)).toBe(true);
    expect(dismissedIn(vault)).toBe(false);
  });

  it("stays closed when the panel shows the tab again, or another tab, until restored", () => {
    showBrowserTabInPanel(curtains, "amazon")();
    useFloatingBrowserPreviewStore.getState().dismiss(curtains);

    // Opening and closing the browser panel.
    showBrowserTabInPanel(curtains, "amazon")();
    showBrowserTabInPanel(curtains, "ikea")();
    expect(dismissedIn(curtains)).toBe(true);

    // "Show mini preview" in the browser panel's menu.
    useFloatingBrowserPreviewStore.getState().restore(curtains);
    expect(dismissedIn(curtains)).toBe(false);
  });

  it("persists closed threads across a reload, alongside the card's position", () => {
    useFloatingBrowserPreviewStore.getState().dismiss(curtains);
    useFloatingBrowserPreviewStore.getState().setWidth(320);
    const { partialize, version } = useFloatingBrowserPreviewStore.persist.getOptions();
    const saved = JSON.parse(
      JSON.stringify(partialize?.(useFloatingBrowserPreviewStore.getState())),
    );

    // Targets refill as panels show tabs; they are not saved.
    expect(saved).not.toHaveProperty("targets");
    const restored = migratePersistedFloatingPreview(saved, version ?? 0);
    expect(restored.width).toBe(320);
    expect(selectFloatingPreviewDismissed(restored, curtains)).toBe(true);
    expect(selectFloatingPreviewDismissed(restored, vault)).toBe(false);
  });
});

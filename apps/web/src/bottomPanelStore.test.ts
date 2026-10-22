import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  migratePersistedBottomPanelState,
  selectThreadBottomPanelState,
  useBottomPanelStore,
} from "./bottomPanelStore";

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-bottom"),
};
const read = () =>
  selectThreadBottomPanelState(useBottomPanelStore.getState().byThreadKey, threadRef);

describe("useBottomPanelStore", () => {
  it("opens on a run the user picked, on that agent's tab, and brings a closed tab back", () => {
    const store = useBottomPanelStore.getState();
    store.hideTab(threadRef, "child-1", "2026-10-21T10:00:00.000Z");
    expect(read()).toMatchObject({ open: false, hiddenTabs: { "child-1": expect.any(String) } });

    store.showRun(threadRef, "child-1", "agent-7");

    expect(read()).toEqual({
      open: true,
      activeTabId: "child-1",
      selectedRunByTabId: { "child-1": "agent-7" },
    });
  });

  it("keeps the dragged height while the panel closes and reopens", () => {
    const store = useBottomPanelStore.getState();
    store.setHeight(threadRef, 360);
    store.toggle(threadRef);
    expect(read()).toMatchObject({ open: false, height: 360 });
    store.toggle(threadRef);
    expect(read()).toMatchObject({ open: true, height: 360 });
  });

  it("moves off a tab the user closes", () => {
    useBottomPanelStore.getState().hideTab(threadRef, "child-1", "2026-10-21T10:01:00.000Z");
    expect(read().activeTabId).toBeUndefined();
    expect(read().selectedRunByTabId).toEqual({ "child-1": "agent-7" });
  });
});

describe("migratePersistedBottomPanelState", () => {
  it("keeps valid thread entries and drops malformed ones", () => {
    expect(
      migratePersistedBottomPanelState({
        byThreadKey: {
          "env-1:thread-1": { open: true, height: 320, activeTabId: "thread-1" },
          "env-1:thread-2": { open: "yes", height: "tall" },
          "not-a-thread-key": { open: true },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-1": { open: true, height: 320, activeTabId: "thread-1" },
        "env-1:thread-2": { open: false },
      },
    });
  });
});

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  migratePersistedRightPanelState,
  selectActiveRightPanelSurface,
  selectGroupSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("migratePersistedRightPanelState", () => {
  it("drops terminal surfaces now that agent terminals live in the bottom panel", () => {
    const migrated = migratePersistedRightPanelState({
      byThreadKey: {
        "env-1:thread-1": {
          isOpen: true,
          activeSurfaceId: "terminal",
          surfaces: [
            { id: "terminal", kind: "terminal", activeTerminalId: "agent-1" },
            { id: "device", kind: "device" },
          ],
        },
        "env-1:thread-2": {
          isOpen: true,
          activeSurfaceId: "terminal",
          surfaces: [{ id: "terminal", kind: "terminal" }],
        },
      },
    });

    expect(migrated.byThreadKey["env-1:thread-1"]).toMatchObject({
      isOpen: true,
      activeSurfaceId: "device",
      surfaces: [{ id: "device", kind: "device" }],
    });
    // A panel that only held the terminal does not reopen empty.
    expect(migrated.byThreadKey["env-1:thread-2"]).toMatchObject({
      isOpen: false,
      surfaces: [],
    });
  });
});

describe("selectActiveRightPanelSurface", () => {
  it("shows the first tab when the stored selection no longer matches one", () => {
    const byThreadKey = {
      "env-1:thread-1": {
        isOpen: true,
        activeSurfaceId: "browser:gone",
        surfaces: [
          { id: "device" as const, kind: "device" as const },
          { id: "files" as const, kind: "files" as const },
        ],
      },
    };
    expect(selectActiveRightPanelSurface(byThreadKey, threadRef)?.id).toBe("device");
  });
});

describe("activateGroup", () => {
  const groupThreadRef = {
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("thread-groups"),
  };
  const read = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, groupThreadRef);

  it("returns to the browser tab the user last had, not the first one", () => {
    const store = useRightPanelStore.getState();
    store.openBrowser(groupThreadRef, "tab-1");
    store.openBrowser(groupThreadRef, "tab-2");
    store.openBrowser(groupThreadRef, "tab-3");
    store.activateSurface(groupThreadRef, "browser:tab-2");
    store.open(groupThreadRef, "device");
    expect(read().activeSurfaceId).toBe("device");

    store.activateGroup(groupThreadRef, "browser");

    expect(read().activeSurfaceId).toBe("browser:tab-2");
    expect(read().isOpen).toBe(true);
  });

  it("forgets closed surfaces and falls back to the group's first tab", () => {
    const store = useRightPanelStore.getState();
    store.closeSurface(groupThreadRef, "browser:tab-2");
    store.open(groupThreadRef, "device");

    store.activateGroup(groupThreadRef, "browser");

    expect(read().recentSurfaceIds).not.toContain("browser:tab-2");
    // tab-3 was active right after tab-2 closed, so it is the most recent browser tab.
    expect(read().activeSurfaceId).toBe("browser:tab-3");
  });

  it("does nothing for a group with no surface, so the caller can create one", () => {
    const before = read();
    useRightPanelStore.getState().activateGroup(groupThreadRef, "files");
    expect(read()).toBe(before);
    expect(selectGroupSurface(before, "files")).toBeNull();
  });

  it("treats the explorer and open files as one group", () => {
    const store = useRightPanelStore.getState();
    store.openFile(groupThreadRef, "src/a.ts");
    store.open(groupThreadRef, "device");

    store.activateGroup(groupThreadRef, "files");

    expect(read().activeSurfaceId).toBe("file:src/a.ts");
  });
});

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
  it("folds per-shell terminal surfaces into the single agent terminal surface", () => {
    const migrated = migratePersistedRightPanelState({
      byThreadKey: {
        "env-1:thread-1": {
          isOpen: true,
          activeSurfaceId: "terminal:term-2",
          surfaces: [
            { id: "diff", kind: "diff" },
            {
              id: "terminal:term-1",
              kind: "terminal",
              resourceId: "term-1",
              terminalIds: ["term-1"],
              activeTerminalId: "term-1",
            },
            {
              id: "terminal:term-2",
              kind: "terminal",
              resourceId: "term-2",
              terminalIds: ["term-2", "term-3"],
              activeTerminalId: "term-3",
            },
          ],
        },
      },
    });
    expect(migrated.byThreadKey["env-1:thread-1"]).toEqual({
      isOpen: true,
      activeSurfaceId: "terminal",
      surfaces: [{ id: "terminal", kind: "terminal" }],
    });
  });
});

describe("terminal surface actions", () => {
  it("reveals an agent terminal in the single terminal surface", () => {
    useRightPanelStore.getState().open(threadRef, "files");

    useRightPanelStore.getState().revealAgentTerminal(threadRef, "agent-1");

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
    expect(state.isOpen).toBe(true);
    expect(state.activeSurfaceId).toBe("terminal");
    expect(state.surfaces).toContainEqual({
      id: "terminal",
      kind: "terminal",
      activeTerminalId: "agent-1",
    });

    // A later reveal selects the newer command in the same surface.
    useRightPanelStore.getState().revealAgentTerminal(threadRef, "agent-2");
    const next = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
    expect(next.surfaces.filter((surface) => surface.kind === "terminal")).toEqual([
      { id: "terminal", kind: "terminal", activeTerminalId: "agent-2" },
    ]);
  });

  it("keeps a selected shell when the agent starts a command", () => {
    useRightPanelStore.getState().openTerminal(threadRef, "term-1");

    useRightPanelStore.getState().revealAgentTerminal(threadRef, "agent-3");

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
    expect(state.activeSurfaceId).toBe("terminal");
    expect(state.surfaces).toContainEqual({
      id: "terminal",
      kind: "terminal",
      activeTerminalId: "term-1",
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
          { id: "terminal" as const, kind: "terminal" as const },
          { id: "device" as const, kind: "device" as const },
        ],
      },
    };
    expect(selectActiveRightPanelSurface(byThreadKey, threadRef)?.id).toBe("terminal");
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
    store.openTerminal(groupThreadRef);
    expect(read().activeSurfaceId).toBe("terminal");

    store.activateGroup(groupThreadRef, "browser");

    expect(read().activeSurfaceId).toBe("browser:tab-2");
    expect(read().isOpen).toBe(true);
  });

  it("forgets closed surfaces and falls back to the group's first tab", () => {
    const store = useRightPanelStore.getState();
    store.closeSurface(groupThreadRef, "browser:tab-2");
    store.openTerminal(groupThreadRef);

    store.activateGroup(groupThreadRef, "browser");

    expect(read().recentSurfaceIds).not.toContain("browser:tab-2");
    // tab-3 was active right after tab-2 closed, so it is the most recent browser tab.
    expect(read().activeSurfaceId).toBe("browser:tab-3");
  });

  it("does nothing for a group with no surface, so the caller can create one", () => {
    const before = read();
    useRightPanelStore.getState().activateGroup(groupThreadRef, "device");
    expect(read()).toBe(before);
    expect(selectGroupSurface(before, "device")).toBeNull();
  });

  it("treats the explorer and open files as one group", () => {
    const store = useRightPanelStore.getState();
    store.openFile(groupThreadRef, "src/a.ts");
    store.openTerminal(groupThreadRef);

    store.activateGroup(groupThreadRef, "files");

    expect(read().activeSurfaceId).toBe("file:src/a.ts");
  });
});

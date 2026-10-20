import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  migratePersistedRightPanelState,
  selectActiveRightPanelSurface,
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

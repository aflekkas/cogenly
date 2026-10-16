import { describe, expect, it } from "vite-plus/test";

import { type PersistedUiState, parsePersistedState } from "./uiStateStore";

describe("parsePersistedState", () => {
  it("drops a project scope saved by the removed sidebar project filter", () => {
    // Older builds persisted the sidebar's project filter; lists now always show everything.
    const state = parsePersistedState({
      sidebarMode: "tasks",
      sidebarProjectScopeKey: "env-1:project-1",
    } as PersistedUiState);
    expect(state).not.toHaveProperty("sidebarProjectScopeKey");
    expect(state.sidebarMode).toBe("tasks");
  });
});

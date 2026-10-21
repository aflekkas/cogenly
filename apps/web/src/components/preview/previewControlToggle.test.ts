import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewControlToggle } from "./previewControlToggle";

describe("resolvePreviewControlToggle", () => {
  it("only reports control while you drive, with nothing to hand back", () => {
    const state = resolvePreviewControlToggle("you");
    expect(state.pressed).toBe(false);
    expect(state.disabled).toBe(true);
    expect(state.hint).toBe("You have control");
  });

  it("is pressed while the agent drives, and a click takes over", () => {
    const state = resolvePreviewControlToggle("agent");
    expect(state.pressed).toBe(true);
    expect(state.disabled).toBe(false);
    expect(state.hint).toMatch(/^Agent has control/);
  });

  it("treats a tab nobody drives as takeable, not as yours", () => {
    const state = resolvePreviewControlToggle("unclaimed");
    expect(state.pressed).toBe(true);
    expect(state.disabled).toBe(false);
  });

  it("lets you take over from another viewer", () => {
    const state = resolvePreviewControlToggle("another-viewer");
    expect(state.disabled).toBe(false);
    expect(state.hint).toMatch(/take over$/);
  });
});

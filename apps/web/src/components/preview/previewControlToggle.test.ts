import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewControlToggle } from "./previewControlToggle";

describe("resolvePreviewControlToggle", () => {
  it("rests unpressed while you drive, and a click hands the page to the agent", () => {
    const state = resolvePreviewControlToggle("you");
    expect(state.pressed).toBe(false);
    expect(state.disabled).toBe(false);
    expect(state.next).toBe("agent");
  });

  it("is pressed while the agent drives, and a click takes over", () => {
    const state = resolvePreviewControlToggle("agent");
    expect(state.pressed).toBe(true);
    expect(state.hint).toMatch(/^Agent has control/);
    expect(state.next).toBe("you");
  });

  it("treats a tab nobody drives as takeable, not as yours", () => {
    const state = resolvePreviewControlToggle("unclaimed");
    expect(state.pressed).toBe(true);
    expect(state.next).toBe("you");
  });

  it("cannot be clicked while another viewer drives", () => {
    const state = resolvePreviewControlToggle("another-viewer");
    expect(state.disabled).toBe(true);
    expect(state.next).toBeNull();
  });
});

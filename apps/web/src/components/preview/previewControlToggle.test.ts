import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewControlBanner, resolvePreviewControlToggle } from "./previewControlToggle";

const input = (
  controller: "agent" | "you" | "another-viewer" | "unclaimed",
  overrides: { canOperate?: boolean; agentInvolved?: boolean } = {},
) => ({ controller, canOperate: true, agentInvolved: true, ...overrides });

describe("resolvePreviewControlToggle", () => {
  it("is pressed while the agent drives, and a click takes control", () => {
    expect(resolvePreviewControlToggle(input("agent"))).toMatchObject({
      kind: "agent",
      pressed: true,
      action: "take",
    });
  });

  it("is released while you drive an agent's tab, and a click hands it back", () => {
    expect(resolvePreviewControlToggle(input("you"))).toMatchObject({
      kind: "agent",
      pressed: false,
      disabled: false,
      action: "handBack",
    });
  });

  it("stays out of the toolbar on a tab no agent has used", () => {
    expect(resolvePreviewControlToggle(input("you", { agentInvolved: false })).kind).toBe("hidden");
    expect(resolvePreviewControlToggle(input("unclaimed")).kind).toBe("hidden");
  });

  it("cannot hand back a tab another viewer drives", () => {
    expect(resolvePreviewControlToggle(input("another-viewer"))).toMatchObject({
      pressed: false,
      disabled: true,
      action: null,
    });
  });

  it("says a read-only viewer can only watch", () => {
    expect(resolvePreviewControlToggle(input("agent", { canOperate: false })).kind).toBe(
      "readOnly",
    );
  });
});

describe("resolvePreviewControlBanner", () => {
  it("names who drives whenever it is not you", () => {
    expect(resolvePreviewControlBanner(input("agent"))).toBe("Agent is driving");
    expect(resolvePreviewControlBanner(input("another-viewer"))).toBe("Another viewer is driving");
    expect(resolvePreviewControlBanner(input("unclaimed"))).toBe("Nobody is driving");
  });

  it("clears while you drive and for viewers who cannot take control", () => {
    expect(resolvePreviewControlBanner(input("you"))).toBeNull();
    expect(resolvePreviewControlBanner(input("agent", { canOperate: false }))).toBeNull();
  });
});

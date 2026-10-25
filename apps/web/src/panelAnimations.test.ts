import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { readPanelAnimationsActive } from "./panelAnimations";
import { setPanelResizeDragging } from "./lib/panelFlip";

afterEach(() => {
  setPanelResizeDragging(false);
  vi.unstubAllGlobals();
});

describe("panel motion availability", () => {
  it("keeps live resize immediate until the pointer is released", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    expect(readPanelAnimationsActive()).toBe(true);
    setPanelResizeDragging(true);
    expect(readPanelAnimationsActive()).toBe(false);
    setPanelResizeDragging(false);
    expect(readPanelAnimationsActive()).toBe(true);
  });

  it("never starts geometry animation under reduced motion", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    expect(readPanelAnimationsActive()).toBe(false);
    setPanelResizeDragging(true);
    setPanelResizeDragging(false);
    expect(readPanelAnimationsActive()).toBe(false);
  });
});

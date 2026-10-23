import { describe, expect, it } from "vite-plus/test";

import {
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarDragMaximumWidth,
} from "./threadSidebarWidth";

describe("resolveInitialThreadSidebarWidth", () => {
  it("keeps the list column between 304 and 344px", () => {
    expect(resolveInitialThreadSidebarWidth(null, 1280)).toBe(304);
    expect(resolveInitialThreadSidebarWidth(null, 1432)).toBe(315);
    expect(resolveInitialThreadSidebarWidth(null, 2560)).toBe(344);
  });

  it("keeps a stored width", () => {
    expect(resolveInitialThreadSidebarWidth(380, 1432)).toBe(380);
  });

  it("holds a stored width inside the minimum and what the window leaves the chat", () => {
    expect(resolveInitialThreadSidebarWidth(100, 1432)).toBe(208);
    expect(resolveInitialThreadSidebarWidth(1200, 1000)).toBe(680);
  });
});

describe("resolveThreadSidebarDragMaximumWidth", () => {
  it("leaves the chat column its minimum without a right panel", () => {
    expect(
      resolveThreadSidebarDragMaximumWidth({
        availableWidth: 1400,
        minimumWidth: 208,
        currentWidth: 304,
        rightPanelMinimumWidth: null,
      }),
    ).toBe(1080);
  });

  it("stops where an open right panel would drop under its minimum", () => {
    expect(
      resolveThreadSidebarDragMaximumWidth({
        availableWidth: 1400,
        minimumWidth: 208,
        currentWidth: 304,
        rightPanelMinimumWidth: 360,
      }),
    ).toBe(720);
  });

  it("never caps a drag under the column's current width", () => {
    expect(
      resolveThreadSidebarDragMaximumWidth({
        availableWidth: 900,
        minimumWidth: 208,
        currentWidth: 304,
        rightPanelMinimumWidth: 360,
      }),
    ).toBe(304);
  });
});

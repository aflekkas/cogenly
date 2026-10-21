import { describe, expect, it } from "vite-plus/test";

import {
  resolveTabWidths,
  TAB_ICON_WIDTH,
  TAB_MAX_WIDTH,
  TAB_MIN_READABLE_WIDTH,
} from "./rightPanelTabWidths";

describe("resolveTabWidths", () => {
  it("gives every tab its full width while the strip has room", () => {
    expect(resolveTabWidths(3, 0, 600)).toEqual([TAB_MAX_WIDTH, TAB_MAX_WIDTH, TAB_MAX_WIDTH]);
  });

  it("shrinks all tabs evenly, keeping their titles, once room runs out", () => {
    const widths = resolveTabWidths(4, 1, 420);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBeGreaterThanOrEqual(TAB_MIN_READABLE_WIDTH);
    expect(widths[0]).toBeLessThan(TAB_MAX_WIDTH);
  });

  it("turns only the inactive tabs into icons as the last resort", () => {
    const widths = resolveTabWidths(5, 2, 300);
    expect(widths.filter((width) => width === TAB_ICON_WIDTH)).toHaveLength(4);
    expect(widths[2]).toBeGreaterThanOrEqual(TAB_MIN_READABLE_WIDTH);
    // The selected tab takes what the icons leave, up to its cap.
    expect(widths[2]).toBe(300 - 4 * 2 - 4 * TAB_ICON_WIDTH);
  });

  it("never lets the selected tab fall below the readable minimum", () => {
    const widths = resolveTabWidths(8, 0, 120);
    expect(widths[0]).toBe(TAB_MIN_READABLE_WIDTH);
  });

  it("keeps the first tab readable when none is selected", () => {
    expect(resolveTabWidths(3, -1, 100)[0]).toBe(TAB_MIN_READABLE_WIDTH);
  });
});

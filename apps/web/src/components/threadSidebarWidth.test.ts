import { describe, expect, it } from "vite-plus/test";

import { resolveInitialThreadSidebarWidth } from "./threadSidebarWidth";

describe("resolveInitialThreadSidebarWidth", () => {
  it("keeps the list column between 304 and 344px", () => {
    expect(resolveInitialThreadSidebarWidth(null, 1280)).toBe(304);
    expect(resolveInitialThreadSidebarWidth(null, 1432)).toBe(315);
    expect(resolveInitialThreadSidebarWidth(null, 2560)).toBe(344);
  });

  it("keeps a stored width", () => {
    expect(resolveInitialThreadSidebarWidth(380, 1432)).toBe(380);
  });
});

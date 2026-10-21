import { describe, expect, it } from "vite-plus/test";

import { resolveInitialThreadSidebarWidth } from "./threadSidebarWidth";

describe("resolveInitialThreadSidebarWidth", () => {
  it("keeps the list column between 256 and 296px", () => {
    expect(resolveInitialThreadSidebarWidth(null, 1280)).toBe(256);
    expect(resolveInitialThreadSidebarWidth(null, 1432)).toBe(272);
    expect(resolveInitialThreadSidebarWidth(null, 2560)).toBe(296);
  });

  it("keeps a stored width", () => {
    expect(resolveInitialThreadSidebarWidth(380, 1432)).toBe(380);
  });
});

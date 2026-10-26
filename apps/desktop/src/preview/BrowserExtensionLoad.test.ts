import { describe, expect, it } from "@effect/vitest";

import { planExtensionLoad } from "./BrowserExtensionLoad.ts";

describe("planExtensionLoad", () => {
  const a = { id: "a".repeat(32), path: "/store/a/1.0-x" };
  const b = { id: "b".repeat(32), path: "/store/b/2.0-y" };

  it("leaves what already runs and loads what is new", () => {
    expect(planExtensionLoad([a], [a, b])).toEqual({ unload: [], load: [b] });
  });

  it("unloads what was removed or turned off", () => {
    expect(planExtensionLoad([a, b], [b])).toEqual({ unload: [a.id], load: [] });
    expect(planExtensionLoad([a, b], [])).toEqual({ unload: [a.id, b.id], load: [] });
  });

  it("reloads an updated extension from its new directory", () => {
    const updated = { ...a, path: "/store/a/1.1-z" };
    expect(planExtensionLoad([a], [updated])).toEqual({ unload: [a.id], load: [updated] });
  });
});

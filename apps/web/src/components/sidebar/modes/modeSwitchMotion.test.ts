import { describe, expect, it } from "vite-plus/test";

import { modeSwitchDirection } from "./modeSwitchMotion";

describe("modeSwitchDirection", () => {
  it("follows the rail order", () => {
    expect(modeSwitchDirection("chats", "tasks")).toBe("from-below");
    expect(modeSwitchDirection("projects", "agents")).toBe("from-above");
  });

  it("does not move when the same mode is picked again", () => {
    expect(modeSwitchDirection("tasks", "tasks")).toBeNull();
  });
});

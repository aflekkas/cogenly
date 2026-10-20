import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { MuseSettings } from "./settings.ts";

const decodeMuseSettings = Schema.decodeUnknownSync(MuseSettings);

describe("MuseSettings", () => {
  it("enables the default instance like Codex and Claude", () => {
    expect(decodeMuseSettings({}).enabled).toBe(true);
  });

  it("honors an explicit opt-out", () => {
    expect(decodeMuseSettings({ enabled: false }).enabled).toBe(false);
  });
});

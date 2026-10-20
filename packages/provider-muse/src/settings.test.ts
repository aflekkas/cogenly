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

  it("refreshes limits automatically on the cheapest model every 30 minutes by default", () => {
    const decoded = decodeMuseSettings({});
    expect(decoded.limitsAutoRefresh).toBe(true);
    expect(decoded.limitsBumpModel).toBe("");
    expect(decoded.limitsMinInterval).toBe("30");
  });

  it("keeps explicit limits refresh choices", () => {
    const decoded = decodeMuseSettings({
      limitsAutoRefresh: false,
      limitsBumpModel: "muse-spark-1.3",
      limitsMinInterval: "60",
    });
    expect(decoded.limitsAutoRefresh).toBe(false);
    expect(decoded.limitsBumpModel).toBe("muse-spark-1.3");
    expect(decoded.limitsMinInterval).toBe("60");
  });

  it("rejects an off-menu refresh interval", () => {
    expect(() => decodeMuseSettings({ limitsMinInterval: "45" })).toThrow();
  });

  it("renders the limits refresh fields after the binary path", () => {
    expect(Schema.resolveAnnotations(MuseSettings)?.providerSettingsFormSchema).toEqual({
      order: ["binaryPath", "limitsAutoRefresh", "limitsBumpModel", "limitsMinInterval"],
    });
    const fields = MuseSettings.fields;
    const formAnnotation = (field: (typeof fields)[keyof typeof fields]) =>
      Schema.resolveAnnotationsKey(field)?.providerSettingsForm;
    expect(formAnnotation(fields.limitsAutoRefresh!)).toEqual({ control: "switch" });
    expect(formAnnotation(fields.limitsBumpModel!)?.control).toBe("select");
    expect(formAnnotation(fields.limitsBumpModel!)?.options?.[0]).toEqual({
      value: "",
      label: "Cheapest available",
    });
    expect(formAnnotation(fields.limitsMinInterval!)?.control).toBe("select");
  });
});

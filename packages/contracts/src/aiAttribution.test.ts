import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  ServerSettings,
  ServerSettingsPatch,
  resolveAiAttribution,
  UNIVERSAL_SERVER_SETTING_KEYS,
} from "./settings.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const decodePatch = Schema.decodeSync(ServerSettingsPatch);

describe("AI attribution preference", () => {
  const decode = Schema.decodeSync(ServerSettings);
  it("defaults off, including existing settings files", () => {
    const settings = decode({});
    expect(settings.aiAttribution).toEqual({ enabled: false, providers: {} });
    expect(resolveAiAttribution(settings, "claudeAgent")).toBe(false);
  });
  it.each([false, true])("resolves overrides and inherit for global=%s", (enabled) => {
    const settings = decode({
      aiAttribution: {
        enabled,
        providers: {
          [ProviderInstanceId.make("claudeAgent")]: "on",
          [ProviderInstanceId.make("codex")]: "off",
          [ProviderInstanceId.make("muse")]: "inherit",
        },
      },
    });
    expect(resolveAiAttribution(settings, "claudeAgent")).toBe(true);
    expect(resolveAiAttribution(settings, "codex")).toBe(false);
    expect(resolveAiAttribution(settings, "muse")).toBe(enabled);
    expect(resolveAiAttribution(settings, "grok")).toBe(enabled);
    expect(resolveAiAttribution(settings)).toBe(enabled);
  });
  it("round trips through RPC patches and belongs to universal sync", () => {
    const patch = {
      aiAttribution: {
        enabled: true,
        providers: { [ProviderInstanceId.make("codex")]: "off" as const },
      },
    };
    expect(decodePatch(patch)).toEqual(patch);
    expect(decodePatch({ aiAttribution: { enabled: true } })).toEqual({
      aiAttribution: { enabled: true },
    });
    expect(UNIVERSAL_SERVER_SETTING_KEYS).toContain("aiAttribution");
  });
});

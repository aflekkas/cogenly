import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveHandoffEndpointDisplay } from "./handoffEndpoint.logic";

function provider(driver: string, models: ServerProvider["models"]): ServerProvider {
  return {
    driver: ProviderDriverKind.make(driver),
    instanceId: ProviderInstanceId.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    version: null,
    checkedAt: "2026-10-25T00:00:00.000Z",
    models,
    slashCommands: [],
    skills: [],
  };
}

const claude = provider("claudeAgent", [
  { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
]);
const codex = provider("codex", []);

describe("resolveHandoffEndpointDisplay", () => {
  it("names a configured instance's model and provider", () => {
    expect(
      resolveHandoffEndpointDisplay({
        providers: [codex, claude],
        instanceId: claude.instanceId,
        model: "claude-opus-5-5",
      }),
    ).toMatchObject({ label: "Claude Opus 5.5", driverKind: claude.driver });
  });

  it("borrows the driver serving the same model when the thread's instance is gone", () => {
    expect(
      resolveHandoffEndpointDisplay({
        providers: [codex, claude],
        instanceId: ProviderInstanceId.make("claude-personal"),
        model: "claude-opus-5-5",
      }),
    ).toEqual({
      label: "Claude Opus 5.5",
      providerName: "Claude",
      driverKind: claude.driver,
      accentColor: undefined,
    });
  });

  it("formats an unknown model slug instead of showing it raw", () => {
    expect(
      resolveHandoffEndpointDisplay({
        providers: [codex],
        instanceId: ProviderInstanceId.make("claude-personal"),
        model: "claude-opus-5-5",
      }).label,
    ).toBe("Claude Opus 5.5");
  });
});

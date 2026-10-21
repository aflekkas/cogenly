import { ProviderDriverKind, UsageProviderKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  barColorForDriver,
  defaultClientModelForDriver,
  defaultClientTextGenerationModelForDriver,
  defineProviderClient,
  isClientPickerVisible,
  makeProviderClientRegistry,
  primaryOnboardingDriverKinds,
  usagePresentationForKind,
} from "./client.ts";

const settingsSchema = Schema.Struct({ binaryPath: Schema.String });

describe("makeProviderClientRegistry", () => {
  it("looks definitions up by driver kind and keeps unknown drivers undefined", () => {
    const codex = defineProviderClient({
      driverKind: ProviderDriverKind.make("codex"),
      label: "Codex",
      settingsSchema,
    });
    const registry = makeProviderClientRegistry([codex]);

    expect(registry.get(ProviderDriverKind.make("codex"))).toBe(codex);
    expect(registry.get(ProviderDriverKind.make("forkDriver"))).toBeUndefined();
    expect(registry.get(undefined)).toBeUndefined();
  });

  it("rejects two definitions for one driver kind", () => {
    const definition = defineProviderClient({
      driverKind: ProviderDriverKind.make("codex"),
      label: "Codex",
      settingsSchema,
    });

    expect(() => makeProviderClientRegistry([definition, definition])).toThrow(
      "Provider driver 'codex' is defined more than once.",
    );
  });
});

describe("client registry queries", () => {
  const fourth = defineProviderClient({
    driverKind: ProviderDriverKind.make("fourth"),
    label: "Fourth",
    settingsSchema,
    defaultModel: "fourth-default",
    defaultTextGenerationModel: "fourth-cheap",
    usage: {
      providerKind: UsageProviderKind.make("fourth"),
      label: "Fourth",
      color: "#123456",
    },
    onboarding: { primary: true },
  });
  const hidden = defineProviderClient({
    driverKind: ProviderDriverKind.make("hidden"),
    label: "Hidden",
    settingsSchema,
    pickerVisible: false,
  });
  const registry = makeProviderClientRegistry([fourth, hidden]);
  const unknown = ProviderDriverKind.make("retired");

  it("flows a new driver's defaults to the picker fallbacks", () => {
    expect(defaultClientModelForDriver(registry, fourth.driverKind)).toBe("fourth-default");
    expect(defaultClientTextGenerationModelForDriver(registry, fourth.driverKind)).toBe(
      "fourth-cheap",
    );
    expect(defaultClientModelForDriver(registry, unknown)).toBeUndefined();
  });

  it("shows registered drivers in the picker unless they opt out", () => {
    expect(isClientPickerVisible(registry, fourth.driverKind)).toBe(true);
    expect(isClientPickerVisible(registry, hidden.driverKind)).toBe(false);
    expect(isClientPickerVisible(registry, unknown)).toBe(false);
  });

  it("presents a new driver's usage with its own label and colour", () => {
    expect(usagePresentationForKind(registry, UsageProviderKind.make("fourth"))).toEqual({
      label: "Fourth",
      color: "#123456",
      driverKind: fourth.driverKind,
    });
    expect(barColorForDriver(registry, fourth.driverKind)).toBe("#123456");
    expect(barColorForDriver(registry, unknown)).toBeUndefined();
  });

  it("renders retired slugs with a neutral row instead of dropping them", () => {
    expect(usagePresentationForKind(registry, UsageProviderKind.make("grok"))).toEqual({
      label: "grok",
      color: "var(--muted-foreground)",
      driverKind: undefined,
    });
  });

  it("lists only primary drivers for onboarding", () => {
    expect(primaryOnboardingDriverKinds(registry)).toEqual([fourth.driverKind]);
  });
});

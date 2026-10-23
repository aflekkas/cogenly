import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  isUnconfiguredDefaultInstanceEnabled,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { primaryOnboardingDriverKinds } from "@t3tools/provider-core/client";
import { describe, expect, it } from "vite-plus/test";

import { providerClients } from "./providerDriverMeta";

describe("providerClients", () => {
  it("matches the contracts mirrors for callers without registry access", () => {
    for (const definition of providerClients.definitions) {
      const kind = definition.driverKind;
      expect(definition.label, `${kind} label`).toBe(PROVIDER_DISPLAY_NAMES[kind]);
      expect(definition.defaultModel, `${kind} defaultModel`).toBe(DEFAULT_MODEL_BY_PROVIDER[kind]);
      expect(definition.defaultTextGenerationModel, `${kind} defaultTextGenerationModel`).toBe(
        DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[kind],
      );
    }
  });

  it("keeps presentation order Codex, Claude, Muse Code, Grok", () => {
    expect(providerClients.definitions.map((definition) => definition.driverKind)).toEqual([
      ProviderDriverKind.make("codex"),
      ProviderDriverKind.make("claudeAgent"),
      ProviderDriverKind.make("muse"),
      ProviderDriverKind.make("grok"),
    ]);
  });

  it("ships every definition with a glyph, usage colours, and picker visibility", () => {
    for (const definition of providerClients.definitions) {
      expect(definition.icon, `${definition.driverKind} icon`).toBeDefined();
      expect(definition.usage, `${definition.driverKind} usage`).toBeDefined();
      expect(definition.pickerVisible, `${definition.driverKind} pickerVisible`).toBe(true);
    }
    const usageKinds = providerClients.definitions.map(
      (definition) => definition.usage?.providerKind,
    );
    expect(new Set(usageKinds).size).toBe(providerClients.definitions.length);
  });

  it("onboards Codex and Claude as the primary agents", () => {
    expect(primaryOnboardingDriverKinds(providerClients)).toEqual([
      ProviderDriverKind.make("codex"),
      ProviderDriverKind.make("claudeAgent"),
    ]);
    for (const kind of primaryOnboardingDriverKinds(providerClients)) {
      const onboarding = providerClients.get(kind)?.onboarding;
      expect(onboarding?.installCommands, `${kind} installers`).toBeDefined();
      expect(onboarding?.loginSubcommand, `${kind} login`).toBeDefined();
    }
  });

  it("reserves a default id exactly where settings assume one", () => {
    for (const definition of providerClients.definitions) {
      const enabled = isUnconfiguredDefaultInstanceEnabled(
        defaultInstanceIdForDriver(definition.driverKind),
      );
      expect(enabled, `${definition.driverKind} unconfigured default`).toBe(
        definition.hasDefaultInstance !== false,
      );
    }
  });
});

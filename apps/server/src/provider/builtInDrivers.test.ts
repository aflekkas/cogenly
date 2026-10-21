import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  isUnconfiguredDefaultInstanceEnabled,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
} from "@t3tools/contracts";
import {
  defaultModelForDriver,
  defaultTextGenerationModelForDriver,
  normalizeDriverVersion,
  textGenerationFallbackDriverKinds,
} from "@t3tools/provider-core/server/driver";
import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS, BUILT_IN_USAGE_DRIVERS } from "./builtInDrivers.ts";

describe("built-in usage drivers", () => {
  it("scans Muse transcripts alongside Claude and Codex", () => {
    const usageProviders = BUILT_IN_USAGE_DRIVERS.map((driver) =>
      driver.usage?.kind === "transcripts" ? driver.usage.provider : null,
    );
    expect(usageProviders).toEqual(["claude", "codex", "muse"]);
  });

  it("gives every built-in driver a usage reader", () => {
    for (const driver of BUILT_IN_DRIVERS) {
      expect(
        BUILT_IN_USAGE_DRIVERS.some((usage) => usage.driverKind === driver.driverKind),
        `${driver.driverKind} is missing from the usage scan`,
      ).toBe(true);
    }
  });
});

describe("built-in driver metadata", () => {
  it("matches the contracts mirrors for callers without registry access", () => {
    for (const driver of BUILT_IN_DRIVERS) {
      const kind = driver.driverKind;
      expect(defaultModelForDriver(BUILT_IN_DRIVERS, kind), `${kind} defaultModel`).toBe(
        DEFAULT_MODEL_BY_PROVIDER[kind],
      );
      expect(
        defaultTextGenerationModelForDriver(BUILT_IN_DRIVERS, kind),
        `${kind} defaultTextGenerationModel`,
      ).toBe(DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[kind]);
      expect(driver.metadata.displayName, `${kind} displayName`).toBe(PROVIDER_DISPLAY_NAMES[kind]);
    }
  });

  it("keeps the text-generation fallback order Codex, Claude, Muse", () => {
    expect(textGenerationFallbackDriverKinds(BUILT_IN_DRIVERS)).toEqual([
      ProviderDriverKind.make("codex"),
      ProviderDriverKind.make("claudeAgent"),
      ProviderDriverKind.make("muse"),
    ]);
  });

  it("declares the usage slug its reader scans as", () => {
    for (const driver of BUILT_IN_DRIVERS) {
      const reader = BUILT_IN_USAGE_DRIVERS.find(
        (usage) => usage.driverKind === driver.driverKind,
      )?.usage;
      expect(driver.metadata.usageKind, `${driver.driverKind} usageKind`).toBe(reader?.provider);
    }
  });

  it("runs a default instance exactly where settings assume one", () => {
    for (const driver of BUILT_IN_DRIVERS) {
      const enabled = isUnconfiguredDefaultInstanceEnabled(
        defaultInstanceIdForDriver(driver.driverKind),
      );
      expect(enabled, `${driver.driverKind} unconfigured default`).toBe(
        driver.metadata.hasDefaultInstance !== false,
      );
    }
  });

  it("strips Muse release revisions before compatibility checks", () => {
    const muse = ProviderDriverKind.make("muse");
    expect(normalizeDriverVersion(BUILT_IN_DRIVERS, muse, "1.2.3-R4")).toBe("1.2.3");
    expect(normalizeDriverVersion(BUILT_IN_DRIVERS, muse, "1.2.3")).toBe("1.2.3");
    const codex = ProviderDriverKind.make("codex");
    expect(normalizeDriverVersion(BUILT_IN_DRIVERS, codex, "1.2.3-R4")).toBe("1.2.3-R4");
  });
});

import { ProviderDriverKind, UsageProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  type AnyProviderDriver,
  defaultModelForDriver,
  defaultTextGenerationModelForDriver,
  getDriverByKind,
  isDriverPickerVisible,
  isRegisteredDriverKind,
  normalizeDriverVersion,
  type ProviderDriverMetadata,
  textGenerationFallbackDriverKinds,
} from "./driver.ts";

const configSchema = Schema.Struct({});
type Config = typeof configSchema.Type;

/** A registered driver with nothing behind it; the queries only read `metadata`. */
function fakeDriver(
  kind: string,
  metadata: ProviderDriverMetadata,
): AnyProviderDriver<never, never> {
  return {
    driverKind: ProviderDriverKind.make(kind),
    metadata,
    configSchema: configSchema as unknown as Schema.Codec<Config, unknown>,
    defaultConfig: () => ({}),
    create: () => Effect.die(new Error("fake driver has no instances")),
  };
}

describe("server registry queries", () => {
  const drivers = [
    fakeDriver("fourth", {
      displayName: "Fourth",
      defaultModel: "fourth-default",
      defaultTextGenerationModel: "fourth-cheap",
      usageKind: UsageProviderKind.make("fourth"),
      textGenerationFallbackPriority: 1,
    }),
    fakeDriver("fifth", {
      displayName: "Fifth",
      defaultModel: "fifth-default",
      defaultTextGenerationModel: "fifth-cheap",
      textGenerationFallbackPriority: 0,
      pickerVisible: false,
      normalizeVersion: (version) => version.replace(/\+rev$/, ""),
    }),
    fakeDriver("noBackstop", { displayName: "No Backstop" }),
  ];
  const fourth = ProviderDriverKind.make("fourth");
  const fifth = ProviderDriverKind.make("fifth");
  const retired = ProviderDriverKind.make("retired");

  it("looks drivers up and reports registration", () => {
    expect(getDriverByKind(drivers, fourth)?.metadata.displayName).toBe("Fourth");
    expect(getDriverByKind(drivers, retired)).toBeUndefined();
    expect(isRegisteredDriverKind(drivers, fourth)).toBe(true);
    expect(isRegisteredDriverKind(drivers, retired)).toBe(false);
  });

  it("flows a new driver's defaults to the model fallbacks", () => {
    expect(defaultModelForDriver(drivers, fourth)).toBe("fourth-default");
    expect(defaultTextGenerationModelForDriver(drivers, fourth)).toBe("fourth-cheap");
    expect(defaultModelForDriver(drivers, retired)).toBeUndefined();
  });

  it("orders the text-generation fallback by priority, skipping opt-outs", () => {
    expect(textGenerationFallbackDriverKinds(drivers)).toEqual([fifth, fourth]);
  });

  it("normalizes versions through the driver's hook", () => {
    expect(normalizeDriverVersion(drivers, fifth, "1.2.3+rev")).toBe("1.2.3");
    expect(normalizeDriverVersion(drivers, fourth, "1.2.3+rev")).toBe("1.2.3+rev");
    expect(normalizeDriverVersion(drivers, retired, "1.2.3+rev")).toBe("1.2.3+rev");
  });

  it("shows registered drivers in the picker unless they opt out", () => {
    expect(isDriverPickerVisible(drivers, fourth)).toBe(true);
    expect(isDriverPickerVisible(drivers, fifth)).toBe(false);
    expect(isDriverPickerVisible(drivers, retired)).toBe(false);
  });
});

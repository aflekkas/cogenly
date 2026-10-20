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

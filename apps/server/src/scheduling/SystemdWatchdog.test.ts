import { describe, expect, it } from "@effect/vitest";

import { shouldPingWatchdog } from "./SystemdWatchdog.ts";

describe("scheduler watchdog", () => {
  it("waits for the first scheduler heartbeat", () => {
    expect(shouldPingWatchdog(100_000, null)).toBe(false);
  });

  it.each([0, 5_000, 20_000])("pings for a heartbeat %i ms old", (age) => {
    expect(shouldPingWatchdog(100_000, 100_000 - age)).toBe(true);
  });

  it.each([20_001, 60_000, Number.POSITIVE_INFINITY])(
    "stops pinging for a heartbeat %i ms old",
    (age) => {
      expect(shouldPingWatchdog(100_000, 100_000 - age)).toBe(false);
    },
  );

  it("rejects invalid or future heartbeat timestamps", () => {
    expect(shouldPingWatchdog(100_000, Number.NaN)).toBe(false);
    expect(shouldPingWatchdog(100_000, 100_001)).toBe(false);
  });
});

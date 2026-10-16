import { describe, expect, it } from "@effect/vitest";

import {
  isValidTimeZone,
  normalizeTimeZoneSetting,
  systemLocalTimeZone,
} from "./serverTimeZone.ts";

describe("server time zone", () => {
  it("defaults to a valid host zone", () => {
    const zone = systemLocalTimeZone();
    expect(zone.length).toBeGreaterThan(0);
    expect(isValidTimeZone(zone)).toBe(true);
  });

  it("validates IANA names", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("EST5")).toBe(false);
  });

  it("treats blank settings as unset", () => {
    expect(normalizeTimeZoneSetting(undefined)).toBeUndefined();
    expect(normalizeTimeZoneSetting("")).toBeUndefined();
    expect(normalizeTimeZoneSetting("   ")).toBeUndefined();
    expect(normalizeTimeZoneSetting("  UTC  ")).toBe("UTC");
  });
});

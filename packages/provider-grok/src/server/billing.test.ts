import { describe, expect, it } from "vite-plus/test";

import { parseGrokAuthFile, parseGrokBilling, readGrokTimestampMs } from "./billing.ts";

const NOW = Date.UTC(2026, 9, 23, 6, 0, 0);

describe("parseGrokBilling", () => {
  it("shows a weekly pool from creditUsagePercent", () => {
    const limits = parseGrokBilling(
      {
        config: {
          creditUsagePercent: 42.5,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-10-20T00:00:00Z",
            end: "2026-10-27T00:00:00Z",
          },
        },
      },
      NOW,
    );
    expect(limits?.windows).toEqual([
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 42.5,
        resetsAt: "2026-10-27T00:00:00.000Z",
        windowDurationMins: 7 * 24 * 60,
      },
    ]);
  });

  it("shows a monthly limit from used and monthlyLimit, as strings or { val }", () => {
    const limits = parseGrokBilling(
      { monthlyLimit: { val: "200" }, used: { val: 50 }, billingPeriodEnd: 1_793_000_000 },
      NOW,
    );
    expect(limits?.windows).toEqual([
      {
        id: "monthly",
        kind: "monthly",
        label: "Monthly",
        usedPercent: 25,
        // 1_793_000_000 epoch seconds.
        resetsAt: "2026-10-26T07:33:20.000Z",
      },
    ]);
  });

  it("reports a period with no usage figure as unavailable with its reset (live _x.ai/billing)", () => {
    // Recorded from grok 1.0.67 on a Free subscription.
    const limits = parseGrokBilling(
      {
        config: {
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-10-20T00:00:00Z",
            end: "2026-10-27T00:00:00Z",
          },
          onDemandCap: { val: "0" },
          onDemandUsed: { val: "0" },
          prepaidBalance: { val: "0" },
          isUnifiedBillingUser: true,
          billingPeriodStart: "2026-10-01T00:00:00Z",
          billingPeriodEnd: "2026-11-01T00:00:00Z",
        },
        subscription_tier: "Free",
      },
      NOW,
    );
    expect(limits).toEqual({
      checkedAt: "2026-10-23T06:00:00.000Z",
      windows: [],
      unavailable: {
        reason: "probeFailed",
        message:
          "Grok hasn't reported usage for this period yet. It resets 2026-10-27T00:00:00.000Z.",
      },
    });
  });

  it("caps over-limit usage at 100 and ignores responses with no usage", () => {
    expect(
      parseGrokBilling({ creditUsagePercent: 140, currentPeriod: { type: "X" } }, NOW)?.windows[0]
        ?.usedPercent,
    ).toBe(100);
    expect(parseGrokBilling({ config: { prepaidBalance: 3 } }, NOW)).toBeUndefined();
    expect(parseGrokBilling("nope", NOW)).toBeUndefined();
  });
});

describe("readGrokTimestampMs", () => {
  it("reads ISO, seconds, millis and { seconds } timestamps", () => {
    expect(readGrokTimestampMs("2026-10-27T00:00:00Z")).toBe(Date.UTC(2026, 9, 27));
    expect(readGrokTimestampMs(1_793_000_000)).toBe(1_793_000_000_000);
    expect(readGrokTimestampMs(1_793_000_000_000)).toBe(1_793_000_000_000);
    expect(readGrokTimestampMs({ seconds: "1793000000" })).toBe(1_793_000_000_000);
    expect(readGrokTimestampMs(undefined)).toBeUndefined();
  });
});

describe("parseGrokAuthFile", () => {
  it("reads the auth.x.ai entry's token, expiry and email", () => {
    const raw = JSON.stringify({
      "https://auth.x.ai::client-123": {
        key: "secret-token",
        expires_at: 1_793_000_000,
        email: "someone@example.com",
      },
    });
    expect(parseGrokAuthFile(raw)).toEqual({
      key: "secret-token",
      expiresAtMs: 1_793_000_000_000,
      email: "someone@example.com",
    });
  });

  it("reads the email claim from a JWT key and ignores other entries", () => {
    const payload = Buffer.from(JSON.stringify({ email: "jwt@example.com" })).toString("base64url");
    const raw = JSON.stringify({
      other: { key: "x" },
      "https://auth.x.ai::c": { key: `h.${payload}.s` },
    });
    expect(parseGrokAuthFile(raw)?.email).toBe("jwt@example.com");
    expect(parseGrokAuthFile("{}")).toBeUndefined();
    expect(parseGrokAuthFile("not json")).toBeUndefined();
  });
});

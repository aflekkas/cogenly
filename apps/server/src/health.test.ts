import { describe, expect, it } from "@effect/vitest";

import { buildHealthResponse } from "./health.ts";

describe("health response", () => {
  it("reports version, uptime, and heartbeat age", () => {
    expect(
      buildHealthResponse({
        version: "0.1.0",
        uptimeSeconds: 4242,
        nowMs: 1_000_000,
        lastTickAtMs: 997_500,
      }),
    ).toEqual({
      ok: true,
      version: "0.1.0",
      uptimeSeconds: 4242,
      schedulerHeartbeatAgeSeconds: 2.5,
    });
  });

  it("reports a null heartbeat age before the first tick", () => {
    const response = buildHealthResponse({
      version: "0.1.0",
      uptimeSeconds: 1,
      nowMs: 1_000_000,
      lastTickAtMs: null,
    });
    expect(response.ok).toBe(true);
    expect(response.schedulerHeartbeatAgeSeconds).toBeNull();
  });

  it("clamps clock skew instead of reporting a negative age", () => {
    const response = buildHealthResponse({
      version: "0.1.0",
      uptimeSeconds: 10,
      nowMs: 1_000_000,
      lastTickAtMs: 1_000_500,
    });
    expect(response.schedulerHeartbeatAgeSeconds).toBe(0);
  });
});

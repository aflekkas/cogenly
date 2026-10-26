import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderUsageLimits } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import { providerUsageHeadroom, USAGE_STALE_AFTER_MS } from "./providerUsageHeadroom.ts";
const now = Date.parse("2026-10-23T12:00:00.000Z");
const later = "2026-10-23T15:00:00.000Z";

function limits(
  windows: ServerProviderUsageLimits["windows"],
  checkedAt = "2026-10-23T11:55:00.000Z",
): ServerProviderUsageLimits {
  return { checkedAt, windows };
}

const session = (usedPercent: number, resetsAt: string | undefined = later) => ({
  id: "five_hour",
  kind: "session" as const,
  label: "Session",
  usedPercent,
  ...(resetsAt === undefined ? {} : { resetsAt }),
});

describe("providerUsageHeadroom", () => {
  it("reports the tightest window as the remaining headroom", () => {
    const headroom = providerUsageHeadroom(
      limits([session(30), { ...session(85), id: "seven_day", kind: "weekly", label: "Weekly" }]),
      now,
    );
    expect(headroom).toMatchObject({ state: "available", remainingPercent: 15, stale: false });
    expect(headroom.windows).toEqual([
      { label: "Session", kind: "session", usedPercent: 30, resetsAt: later },
      { label: "Weekly", kind: "weekly", usedPercent: 85, resetsAt: later },
    ]);
  });

  it("marks a full window exhausted until its reset, and fresh after it", () => {
    expect(providerUsageHeadroom(limits([session(100)]), now).state).toBe("exhausted");
    const reset = providerUsageHeadroom(limits([session(100, "2026-10-23T11:00:00.000Z")]), now);
    expect(reset).toMatchObject({ state: "available", remainingPercent: 100 });
    expect(reset.windows[0]).not.toHaveProperty("resetsAt");
  });

  it("is unknown without a readable window, and flags old readings as stale", () => {
    expect(providerUsageHeadroom(undefined, now)).toMatchObject({
      state: "unknown",
      checkedAt: null,
      stale: false,
    });
    expect(
      providerUsageHeadroom({ ...limits([]), unavailable: { reason: "probeFailed" } }, now).state,
    ).toBe("unknown");
    const old = DateTime.formatIso(DateTime.makeUnsafe(now - USAGE_STALE_AFTER_MS - 1));
    expect(providerUsageHeadroom(limits([session(10)], old), now).stale).toBe(true);
  });
});

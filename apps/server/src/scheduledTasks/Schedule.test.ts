import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  isMissedFixedTimeRun,
  isSameSchedule,
  nextScheduledRunAt,
  parseTimeOfDay,
} from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  it("parses 24-hour times", () => {
    expect(parseTimeOfDay("09:30")).toEqual({ hour: 9, minute: 30 });
    expect(parseTimeOfDay("23:59")).toEqual({ hour: 23, minute: 59 });
    expect(parseTimeOfDay("25:00")).toBeNull();
  });

  it("calculates interval schedules from the supplied instant", () => {
    const next = nextScheduledRunAt(
      { type: "interval", everyMs: 5 * 60_000 },
      DateTime.makeUnsafe("2026-07-01T16:00:00.000Z"),
    );
    expect(next ? DateTime.formatIso(DateTime.toUtc(next)) : null).toBe("2026-07-01T16:05:00.000Z");
  });

  it("clamps legacy sub-minute intervals to the one-minute execution floor", () => {
    const next = nextScheduledRunAt(
      { type: "interval", everyMs: 1_000 },
      DateTime.makeUnsafe("2026-07-01T16:00:00.000Z"),
    );
    expect(next ? DateTime.formatIso(DateTime.toUtc(next)) : null).toBe("2026-07-01T16:01:00.000Z");
  });

  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("keeps the wall time across the spring-forward boundary", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00" },
      DateTime.makeUnsafe("2026-03-07T15:00:00.000Z"),
      { timeZone: "America/New_York" },
    );
    // 09:00 EST would be 14:00Z; after the 2026-03-08 shift it is 09:00 EDT.
    expect(next ? DateTime.formatIso(DateTime.toUtc(next)) : null).toBe("2026-03-08T13:00:00.000Z");
  });

  it("keeps the wall time across the fall-back boundary", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00" },
      DateTime.makeUnsafe("2026-10-31T15:00:00.000Z"),
      { timeZone: "America/New_York" },
    );
    // 09:00 EDT would be 13:00Z; after the 2026-11-01 shift it is 09:00 EST.
    expect(next ? DateTime.formatIso(DateTime.toUtc(next)) : null).toBe("2026-11-01T14:00:00.000Z");
  });

  it("reads the calendar day in the server zone, not in UTC", () => {
    const schedule = { type: "fixed_time", timeOfDay: "09:00" } as const;
    const from = DateTime.makeUnsafe("2026-07-01T23:30:00.000Z");
    const utc = nextScheduledRunAt(schedule, from, { timeZone: "UTC" });
    // In Auckland it is already Thursday 11:30, so Thursday 09:00 has passed
    // and the next run is Friday 09:00 NZST.
    const auckland = nextScheduledRunAt(schedule, from, { timeZone: "Pacific/Auckland" });
    expect(utc ? DateTime.formatIso(DateTime.toUtc(utc)) : null).toBe("2026-07-02T09:00:00.000Z");
    expect(auckland ? DateTime.formatIso(DateTime.toUtc(auckland)) : null).toBe(
      "2026-07-02T21:00:00.000Z",
    );
  });

  it("shifts a fixed time out of the spring-forward gap instead of skipping the day", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "02:30" },
      DateTime.makeUnsafe("2026-03-08T00:00:00.000Z"),
      { timeZone: "America/New_York" },
    );
    // 02:30 does not exist on 2026-03-08 in New York; the run moves forward
    // to 03:30 EDT rather than waiting another day.
    expect(next ? DateTime.formatIso(DateTime.toUtc(next)) : null).toBe("2026-03-08T07:30:00.000Z");
  });

  it("falls back to the caller's zone for an unknown zone name", () => {
    const schedule = { type: "fixed_time", timeOfDay: "09:00" } as const;
    const from = DateTime.makeUnsafe("2026-07-01T16:00:00.000Z");
    const fallback = nextScheduledRunAt(schedule, from, { timeZone: "Mars/Olympus" });
    const plain = nextScheduledRunAt(schedule, from);
    expect(fallback ? DateTime.formatIso(DateTime.toUtc(fallback)) : null).toBe(
      plain ? DateTime.formatIso(DateTime.toUtc(plain)) : null,
    );
  });

  it("skips fixed-time runs missed by more than the grace window", () => {
    const fixedTime = { type: "fixed_time", timeOfDay: "09:00" } as const;
    const dueAt = DateTime.makeUnsafe("2026-07-01T09:00:00.000Z");
    const withinGrace = DateTime.makeUnsafe("2026-07-01T09:05:00.000Z");
    const pastGrace = DateTime.makeUnsafe("2026-07-01T15:00:00.000Z");
    // A run only slightly late (poll jitter, short sleep) still fires.
    expect(isMissedFixedTimeRun(fixedTime, dueAt, withinGrace)).toBe(false);
    // A run hours past its slot is skipped and rescheduled instead.
    expect(isMissedFixedTimeRun(fixedTime, dueAt, pastGrace)).toBe(true);
    // Interval schedules always catch up with a single run, never skip.
    expect(isMissedFixedTimeRun({ type: "interval", everyMs: 60_000 }, dueAt, pastGrace)).toBe(
      false,
    );
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    // Weekday masks are sets: order and duplicates do not change firing.
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    // Omitted, empty, and all-seven masks all mean daily.
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });

  it.each([
    ["9:00", "09:00"],
    ["09:00", "9:00"],
    ["0:30", "00:30"],
  ])("treats %s and %s as the same fixed-time schedule", (before, after) => {
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: before },
        { type: "fixed_time", timeOfDay: after },
      ),
    ).toBe(true);
  });
});

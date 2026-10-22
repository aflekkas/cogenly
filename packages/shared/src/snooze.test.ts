import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  formatSnoozeTime,
  parseSnoozePhrase,
  resolveSnoozePreset,
  resolveSnoozeUntil,
  snoozePresetTimes,
  type SnoozeClock,
} from "./snooze.ts";

const NEW_YORK = "America/New_York";
// Thursday 2026-10-22, 2:19 PM in New York (EDT, UTC-4).
const thursday: SnoozeClock = { nowMs: Date.parse("2026-10-22T18:19:00Z"), timeZone: NEW_YORK };
const iso = (atMs: number | null) =>
  atMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(atMs));
const at = (instant: string, timeZone = NEW_YORK): SnoozeClock => ({
  nowMs: Date.parse(instant),
  timeZone,
});
const presets = (clock: SnoozeClock) =>
  Object.fromEntries(snoozePresetTimes(clock).map((preset) => [preset.key, iso(preset.atMs)]));

describe("snooze presets", () => {
  it("match the menu on a weekday afternoon", () => {
    expect(presets(thursday)).toEqual({
      in_1h: "2026-10-22T19:19:00.000Z",
      in_3h: "2026-10-22T21:19:00.000Z",
      this_evening: "2026-10-22T22:00:00.000Z",
      tomorrow: "2026-10-23T13:00:00.000Z",
      next_week: "2026-10-26T13:00:00.000Z",
    });
  });

  it("drop this evening once 6 PM is under an hour away", () => {
    const late = at("2026-10-22T21:30:00Z");
    expect(presets(late)).not.toHaveProperty("this_evening");
    expect(resolveSnoozePreset("this_evening", late)).toBeNull();
  });

  it("fold next week into tomorrow on a Sunday, but still resolve it by key", () => {
    const sunday = at("2026-10-25T14:00:00Z");
    expect(presets(sunday)).not.toHaveProperty("next_week");
    expect(iso(resolveSnoozePreset("next_week", sunday))).toBe("2026-10-26T13:00:00.000Z");
  });

  it("read the calendar in the given zone", () => {
    // The same instant is already Friday morning in Tokyo.
    const tokyo = { ...thursday, timeZone: "Asia/Tokyo" };
    expect(iso(resolveSnoozePreset("tomorrow", tokyo))).toBe("2026-10-24T00:00:00.000Z");
    expect(iso(resolveSnoozePreset("tomorrow", { ...thursday, timeZone: "UTC" }))).toBe(
      "2026-10-23T09:00:00.000Z",
    );
  });

  it("keep 9 AM across a fall-back transition", () => {
    // Saturday before DST ends (Sunday 2026-11-01).
    const saturday = at("2026-10-31T14:00:00Z");
    expect(iso(resolveSnoozePreset("tomorrow", saturday))).toBe("2026-11-01T14:00:00.000Z");
    expect(iso(resolveSnoozePreset("next_week", saturday))).toBe("2026-11-02T14:00:00.000Z");
  });

  it("keep 9 AM across a spring-forward transition late at night", () => {
    // 11:30 PM Saturday 2026-03-07 EST; the next day is 23 hours long.
    const saturdayNight = at("2026-03-08T04:30:00Z");
    expect(iso(resolveSnoozePreset("tomorrow", saturdayNight))).toBe("2026-03-08T13:00:00.000Z");
  });
});

describe("snooze phrases", () => {
  it.each([
    ["tmrw", "2026-10-23T13:00:00.000Z"],
    ["Tomorrow", "2026-10-23T13:00:00.000Z"],
    ["until tomorrow", "2026-10-23T13:00:00.000Z"],
    ["tomorrow 2pm", "2026-10-23T18:00:00.000Z"],
    ["tomorrow at 2:30 pm", "2026-10-23T18:30:00.000Z"],
    ["2pm tomorrow", "2026-10-23T18:00:00.000Z"],
    ["tomorrow night", "2026-10-23T22:00:00.000Z"],
    ["friday", "2026-10-23T13:00:00.000Z"],
    ["fri", "2026-10-23T13:00:00.000Z"],
    // A weekday is never today.
    ["thursday", "2026-10-29T13:00:00.000Z"],
    ["next mon 10am", "2026-10-26T14:00:00.000Z"],
    ["mon 10", "2026-10-26T14:00:00.000Z"],
    ["10am on monday", "2026-10-26T14:00:00.000Z"],
    ["this weekend", "2026-10-24T13:00:00.000Z"],
    ["next week", "2026-10-26T13:00:00.000Z"],
    ["this evening", "2026-10-22T22:00:00.000Z"],
    ["tonight at 8", "2026-10-23T00:00:00.000Z"],
    ["in 2 days", "2026-10-24T18:19:00.000Z"],
    ["in a week", "2026-10-29T18:19:00.000Z"],
    ["3h", "2026-10-22T21:19:00.000Z"],
    ["in an hour", "2026-10-22T19:19:00.000Z"],
    ["for 30 minutes", "2026-10-22T18:49:00.000Z"],
    ["half an hour", "2026-10-22T18:49:00.000Z"],
    ["5pm", "2026-10-22T21:00:00.000Z"],
    ["17:30", "2026-10-22T21:30:00.000Z"],
    // Already past today, so tomorrow.
    ["noon", "2026-10-23T16:00:00.000Z"],
    ["9am", "2026-10-23T13:00:00.000Z"],
    ["oct 24 3pm", "2026-10-24T19:00:00.000Z"],
    ["24th october", "2026-10-24T13:00:00.000Z"],
    // A date without a year that has passed is next year's.
    ["oct 1", "2027-10-01T13:00:00.000Z"],
    // After the fall-back transition, 9 AM is UTC-5.
    ["2026-11-02", "2026-11-02T14:00:00.000Z"],
  ])("%s", (phrase, expected) => {
    expect(iso(parseSnoozePhrase(phrase, thursday))).toBe(expected);
  });

  it.each(["", "banana", "today", "am", "feb 30", "25pm", "in 0 hours", "yesterday"])(
    "rejects %j",
    (phrase) => {
      expect(parseSnoozePhrase(phrase, thursday)).toBeNull();
    },
  );

  it("keeps the wall time when a day count crosses fall-back", () => {
    // Saturday 10 AM EDT plus one calendar day is Sunday 10 AM EST: 25 hours.
    expect(iso(parseSnoozePhrase("in 1 day", at("2026-10-31T14:00:00Z")))).toBe(
      "2026-11-01T15:00:00.000Z",
    );
  });
});

describe("resolveSnoozeUntil", () => {
  it("accepts presets, ISO times and phrases", () => {
    expect(resolveSnoozeUntil("tomorrow", thursday)).toEqual({
      ok: true,
      atMs: Date.parse("2026-10-23T13:00:00Z"),
    });
    expect(resolveSnoozeUntil("2026-10-23T09:00:00-04:00", thursday)).toEqual({
      ok: true,
      atMs: Date.parse("2026-10-23T13:00:00Z"),
    });
    // Without an offset, an ISO time is wall time in the clock's zone.
    expect(resolveSnoozeUntil("2026-11-03T09:00", thursday)).toEqual({
      ok: true,
      atMs: Date.parse("2026-11-03T14:00:00Z"),
    });
    expect(resolveSnoozeUntil("next mon 10am", thursday)).toEqual({
      ok: true,
      atMs: Date.parse("2026-10-26T14:00:00Z"),
    });
  });

  it("explains what it refuses", () => {
    expect(resolveSnoozeUntil("2026-10-01T09:00:00Z", thursday)).toMatchObject({ ok: false });
    expect(resolveSnoozeUntil("whenever", thursday)).toMatchObject({
      ok: false,
      message: expect.stringContaining("in_1h"),
    });
    expect(resolveSnoozeUntil("this_evening", at("2026-10-22T21:30:00Z"))).toMatchObject({
      ok: false,
      message: expect.stringContaining("evening"),
    });
  });
});

describe("formatSnoozeTime", () => {
  const format = (instant: string) =>
    formatSnoozeTime(Date.parse(instant), thursday, { locale: "en-US" }).replace(/\s/g, " ");

  it("names the weekday within the coming week", () => {
    expect(format("2026-10-23T13:00:00Z")).toBe("Fri 9:00 AM");
    expect(format("2026-10-22T22:00:00Z")).toBe("Thu 6:00 PM");
  });

  it("adds the date beyond a week, and the year when it differs", () => {
    expect(format("2026-11-02T14:00:00Z")).toBe("Mon, Nov 2, 9:00 AM");
    expect(format("2027-10-01T13:00:00Z")).toBe("Fri, Oct 1, 2027, 9:00 AM");
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  chatGreeting,
  chatGreetingRequest,
  greetingBucket,
  isSpecialGreetingDay,
} from "./chatGreeting";

describe("chatGreetingRequest", () => {
  it("names the local day, bucket and weekday", () => {
    expect(chatGreetingRequest(new Date(2026, 9, 25, 9, 30))).toEqual({
      day: "2026-10-25",
      bucket: "morning",
      weekday: 0,
    });
    expect(chatGreetingRequest(new Date(2026, 0, 5, 23)).day).toBe("2026-01-05");
  });

  it("leaves holidays to their built-in line", () => {
    expect(isSpecialGreetingDay(new Date(2026, 11, 25, 9))).toBe(true);
    expect(isSpecialGreetingDay(new Date(2026, 9, 25, 9))).toBe(false);
  });
});

describe("greetingBucket", () => {
  it("splits the day into morning, afternoon, evening and late night", () => {
    const at = (hour: number) => greetingBucket(new Date(2026, 2, 4, hour));
    expect([at(5), at(11), at(12), at(16), at(17), at(21), at(22), at(3)]).toEqual([
      "morning",
      "morning",
      "afternoon",
      "afternoon",
      "evening",
      "evening",
      "lateNight",
      "lateNight",
    ]);
  });
});

describe("chatGreeting", () => {
  it("is stable within a day and time-of-day bucket", () => {
    const first = chatGreeting(new Date(2026, 2, 4, 9, 0), "Alex");
    expect(chatGreeting(new Date(2026, 2, 4, 11, 59), "Alex")).toBe(first);
  });

  it("varies across days", () => {
    const lines = new Set(
      Array.from({ length: 30 }, (_, day) => chatGreeting(new Date(2026, 2, 1 + day, 9))),
    );
    expect(lines.size).toBeGreaterThan(3);
  });

  it("greets without a name rather than inventing one", () => {
    for (let day = 0; day < 60; day += 1) {
      for (const hour of [8, 14, 19, 23]) {
        const line = chatGreeting(new Date(2026, 2, 1 + day, hour));
        expect(line).not.toContain("{");
        expect(line).not.toMatch(/,\s*[.?]/);
        expect(line).not.toContain("undefined");
      }
    }
  });

  it("uses the first name when known", () => {
    expect(chatGreeting(new Date(2026, 11, 25, 9), "Alex")).toBe("Merry Christmas, Alex");
    expect(chatGreeting(new Date(2026, 11, 25, 9))).toBe("Merry Christmas");
    expect(chatGreeting(new Date(2026, 11, 25, 9), "  ")).toBe("Merry Christmas");
  });

  it("shows a special date's line all day", () => {
    expect(chatGreeting(new Date(2026, 9, 31, 2))).toBe("Happy Halloween");
    expect(chatGreeting(new Date(2026, 9, 31, 15))).toBe("Happy Halloween");
  });
});

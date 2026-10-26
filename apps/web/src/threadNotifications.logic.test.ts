import { describe, expect, it } from "vite-plus/test";

import {
  completionWantsSound,
  createSoundCoalescer,
  HISTORY_GRACE_MS,
  threadNotificationKind,
} from "./threadNotifications.logic";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const idle = { attention: null, completion: null };

function kind(overrides: Partial<Parameters<typeof threadNotificationKind>[0]> = {}) {
  return threadNotificationKind({
    prior: idle,
    next: { attention: null, completion: NOW },
    archived: false,
    completedAt: NOW,
    watchingSince: NOW - 10_000,
    ...overrides,
  });
}

describe("threadNotificationKind", () => {
  it("announces a turn that completed while watching", () => {
    expect(kind()).toBe("completion");
  });

  it("stays quiet for a thread seen for the first time, such as a history load or reconnect", () => {
    expect(kind({ prior: undefined })).toBeNull();
  });

  it("announces each turn once", () => {
    const seen = { attention: null, completion: NOW };
    expect(kind({ prior: seen, next: seen })).toBeNull();
    expect(kind({ prior: seen, next: { attention: null, completion: NOW + 5_000 } })).toBe(
      "completion",
    );
  });

  it("skips runs that ended before the client started watching", () => {
    expect(kind({ watchingSince: NOW + HISTORY_GRACE_MS + 1 })).toBeNull();
    expect(kind({ watchingSince: NOW + HISTORY_GRACE_MS - 1 })).toBe("completion");
  });

  it("skips archived threads", () => {
    expect(kind({ archived: true })).toBeNull();
  });

  it("announces a run's ask once", () => {
    const asking = { attention: "run-1:approval", completion: null };
    expect(kind({ next: asking, completedAt: Number.NaN })).toBe("input");
    expect(kind({ prior: asking, next: asking, completedAt: Number.NaN })).toBeNull();
  });
});

describe("completionWantsSound", () => {
  const sentAt = new Date(NOW - 1_500).toISOString();

  it("skips a quick reply in the thread being viewed", () => {
    expect(completionWantsSound({ viewing: true, sentAt, completedAt: NOW })).toBe(false);
  });

  it("sounds for a slow reply in the thread being viewed", () => {
    expect(
      completionWantsSound({
        viewing: true,
        sentAt: new Date(NOW - 2_000).toISOString(),
        completedAt: NOW,
      }),
    ).toBe(true);
  });

  it("sounds for a quick reply in another thread or a background window", () => {
    expect(completionWantsSound({ viewing: false, sentAt, completedAt: NOW })).toBe(true);
  });

  it("sounds when the send time is unknown", () => {
    expect(completionWantsSound({ viewing: true, sentAt: null, completedAt: NOW })).toBe(true);
  });
});

describe("createSoundCoalescer", () => {
  it("plays one sound for threads finishing within a second", () => {
    const coalesce = createSoundCoalescer();
    expect(coalesce(NOW)).toBe(true);
    expect(coalesce(NOW + 200)).toBe(false);
    expect(coalesce(NOW + 999)).toBe(false);
    expect(coalesce(NOW + 1_000)).toBe(true);
  });
});

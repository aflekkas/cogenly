import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  autoMarkReadKey,
  holdThreadUnread,
  isCompletionUnseen,
  releaseThreadUnreadHold,
  shouldAutoMarkThreadRead,
  useThreadUnreadHolds,
} from "./threadReadState";

const completedAt = "2026-10-20T10:00:00.000Z";
const beforeCompletion = "2026-10-20T09:59:59.999Z";
const afterCompletion = "2026-10-20T10:05:00.000Z";

describe("isCompletionUnseen", () => {
  it("is unseen when the reply landed after the last visit, or there was no visit", () => {
    expect(isCompletionUnseen(completedAt, beforeCompletion)).toBe(true);
    expect(isCompletionUnseen(completedAt, null)).toBe(true);
    expect(isCompletionUnseen(completedAt, afterCompletion)).toBe(false);
  });

  it("is never unseen without a completed run", () => {
    expect(isCompletionUnseen(null, null)).toBe(false);
  });
});

describe("shouldAutoMarkThreadRead", () => {
  const base = { latestCompletedAt: completedAt, lastVisitedAt: beforeCompletion, hold: null };

  it("reads an unseen reply only while the window is viewing it", () => {
    expect(shouldAutoMarkThreadRead({ ...base, isViewing: true })).toBe(true);
    expect(shouldAutoMarkThreadRead({ ...base, isViewing: false })).toBe(false);
  });

  it("does nothing for a thread already read", () => {
    expect(
      shouldAutoMarkThreadRead({ ...base, lastVisitedAt: afterCompletion, isViewing: true }),
    ).toBe(false);
  });

  it("keeps an open thread the user marked unread unread", () => {
    expect(shouldAutoMarkThreadRead({ ...base, isViewing: true, hold: { completedAt } })).toBe(
      false,
    );
  });

  it("reads again once a newer run completes after the hold", () => {
    expect(
      shouldAutoMarkThreadRead({
        latestCompletedAt: afterCompletion,
        lastVisitedAt: beforeCompletion,
        isViewing: true,
        hold: { completedAt },
      }),
    ).toBe(true);
  });
});

describe("autoMarkReadKey", () => {
  it("changes when the thread is marked unread again, so it can be read again", () => {
    const read = autoMarkReadKey("env:thread", completedAt, beforeCompletion);
    const rewound = autoMarkReadKey("env:thread", completedAt, "2026-10-20T09:59:59.998Z");
    expect(read).not.toBe(rewound);
    expect(autoMarkReadKey("env:thread", completedAt, beforeCompletion)).toBe(read);
  });
});

describe("unread holds", () => {
  afterEach(() => useThreadUnreadHolds.setState({ holds: {} }));

  it("holds a thread at its latest completion until released", () => {
    holdThreadUnread("env:thread", completedAt);
    expect(useThreadUnreadHolds.getState().holds["env:thread"]).toEqual({ completedAt });
    releaseThreadUnreadHold("env:thread");
    expect(useThreadUnreadHolds.getState().holds["env:thread"]).toBeUndefined();
  });

  it("releasing a thread without a hold leaves the store untouched", () => {
    const before = useThreadUnreadHolds.getState();
    releaseThreadUnreadHold("env:other");
    expect(useThreadUnreadHolds.getState()).toBe(before);
  });
});

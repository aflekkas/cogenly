import { describe, expect, it } from "vite-plus/test";

import {
  canStartThreadIntent,
  createRetainedSnapshotSet,
  createThreadPrefetcher,
  shouldCommitThreadIntent,
  THREAD_INTENT_SCROLL_QUIET_MS,
  touchBoundedKeys,
} from "./threadPrefetch.ts";

function harness(capacity: number) {
  const mounts: string[] = [];
  const unmounts: string[] = [];
  const timers = new Map<number, { run: () => void; cancelled: boolean }>();
  let nextTimer = 0;
  const prefetcher = createThreadPrefetcher({
    capacity,
    idleReleaseMs: 1_000,
    mount: (key) => {
      mounts.push(key);
      return () => unmounts.push(key);
    },
    schedule: (run) => {
      const id = nextTimer++;
      const timer = { run, cancelled: false };
      timers.set(id, timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const fireLiveTimers = () => {
    for (const timer of [...timers.values()]) if (!timer.cancelled) timer.run();
  };
  return { prefetcher, mounts, unmounts, fireLiveTimers };
}

describe("touchBoundedKeys", () => {
  it("moves a key to the recent end and evicts the oldest past capacity", () => {
    expect(touchBoundedKeys(["a", "b", "c"], "a", 3)).toEqual({
      keys: ["b", "c", "a"],
      evicted: [],
    });
    expect(touchBoundedKeys(["a", "b", "c"], "d", 3)).toEqual({
      keys: ["b", "c", "d"],
      evicted: ["a"],
    });
  });
});

describe("createThreadPrefetcher", () => {
  it("dedupes repeat intent into one mount", () => {
    const { prefetcher, mounts, unmounts } = harness(3);
    prefetcher.prefetch("a");
    prefetcher.prefetch("a");
    prefetcher.prefetch("a");
    expect(mounts).toEqual(["a"]);
    expect(unmounts).toEqual([]);
    expect(prefetcher.keys()).toEqual(["a"]);
  });

  it("unmounts the least recent thread when intent moves past capacity", () => {
    const { prefetcher, mounts, unmounts } = harness(2);
    prefetcher.prefetch("a");
    prefetcher.prefetch("b");
    prefetcher.prefetch("a");
    prefetcher.prefetch("c");
    expect(mounts).toEqual(["a", "b", "c"]);
    expect(unmounts).toEqual(["b"]);
    expect(prefetcher.keys()).toEqual(["a", "c"]);
  });

  it("releases a thread left idle, and only the latest idle timer counts", () => {
    const { prefetcher, unmounts, fireLiveTimers } = harness(3);
    prefetcher.prefetch("a");
    prefetcher.prefetch("a");
    fireLiveTimers();
    expect(unmounts).toEqual(["a"]);
    expect(prefetcher.keys()).toEqual([]);
  });

  it("does not release an evicted thread a second time when its old timer fires", () => {
    const { prefetcher, unmounts, fireLiveTimers } = harness(1);
    prefetcher.prefetch("a");
    prefetcher.prefetch("b");
    fireLiveTimers();
    expect(unmounts).toEqual(["a", "b"]);
  });
});

describe("createRetainedSnapshotSet", () => {
  it("drops the oldest closed snapshots beyond capacity", () => {
    const dropped: string[] = [];
    const set = createRetainedSnapshotSet<string>(2, (cache) => dropped.push(cache));
    for (const key of ["a", "b", "c"]) {
      set.opened(key);
      set.closed(key, `cache-${key}`);
    }
    expect(dropped).toEqual(["cache-a"]);
    expect(set.keys()).toEqual(["b", "c"]);
  });

  it("keeps the snapshot of a thread that is open again when it falls off", () => {
    const dropped: string[] = [];
    const set = createRetainedSnapshotSet<string>(1, (cache) => dropped.push(cache));
    set.opened("a");
    set.closed("a", "cache-a");
    set.opened("a");
    set.opened("b");
    set.closed("b", "cache-b");
    expect(dropped).toEqual([]);
    set.closed("a", "cache-a");
    expect(dropped).toEqual(["cache-b"]);
    expect(set.keys()).toEqual(["a"]);
  });
});

describe("thread intent", () => {
  it("ignores touch and rows that slid under the pointer during a scroll", () => {
    expect(canStartThreadIntent({ pointerType: "touch", now: 1_000, lastScrollAt: null })).toBe(
      false,
    );
    expect(canStartThreadIntent({ pointerType: "mouse", now: 1_000, lastScrollAt: 990 })).toBe(
      false,
    );
    expect(
      canStartThreadIntent({
        pointerType: "mouse",
        now: 1_000,
        lastScrollAt: 1_000 - THREAD_INTENT_SCROLL_QUIET_MS,
      }),
    ).toBe(true);
    expect(canStartThreadIntent({ pointerType: "pen", now: 1_000, lastScrollAt: null })).toBe(true);
  });

  it("drops a dwell interrupted by a scroll", () => {
    expect(shouldCommitThreadIntent({ startedAt: 1_000, lastScrollAt: 1_050 })).toBe(false);
    expect(shouldCommitThreadIntent({ startedAt: 1_000, lastScrollAt: 900 })).toBe(true);
    expect(shouldCommitThreadIntent({ startedAt: 1_000, lastScrollAt: null })).toBe(true);
  });
});

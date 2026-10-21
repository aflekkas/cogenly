import { describe, expect, it } from "vite-plus/test";

import {
  isViewportAtRestoreTarget,
  waitForRestoreTarget,
  type FrameScheduler,
} from "./timelineRestoreWait";

function manualFrames() {
  const queue = new Map<number, () => void>();
  let next = 1;
  const frames: FrameScheduler = {
    request: (callback) => {
      const handle = next++;
      queue.set(handle, callback);
      return handle;
    },
    cancel: (handle) => {
      queue.delete(handle);
    },
  };
  const flush = () => {
    const callbacks = [...queue.values()];
    queue.clear();
    for (const callback of callbacks) callback();
  };
  return { frames, flush, pending: () => queue.size };
}

describe("isViewportAtRestoreTarget", () => {
  const viewport = { scrollHeight: 2000, clientHeight: 500 };

  it("reads the end as the largest scroll offset", () => {
    expect(isViewportAtRestoreTarget({ ...viewport, scrollTop: 1500 }, { kind: "end" })).toBe(true);
    expect(isViewportAtRestoreTarget({ ...viewport, scrollTop: 1499.5 }, { kind: "end" })).toBe(
      true,
    );
    expect(isViewportAtRestoreTarget({ ...viewport, scrollTop: 1400 }, { kind: "end" })).toBe(
      false,
    );
  });

  it("clamps an offset past the end, as the browser does", () => {
    expect(
      isViewportAtRestoreTarget({ ...viewport, scrollTop: 1500 }, { kind: "offset", offset: 9000 }),
    ).toBe(true);
    expect(
      isViewportAtRestoreTarget({ ...viewport, scrollTop: 300 }, { kind: "offset", offset: 300 }),
    ).toBe(true);
    expect(
      isViewportAtRestoreTarget({ ...viewport, scrollTop: 0 }, { kind: "offset", offset: 300 }),
    ).toBe(false);
  });

  it("treats content shorter than the viewport as at its end", () => {
    expect(
      isViewportAtRestoreTarget(
        { scrollTop: 0, scrollHeight: 200, clientHeight: 500 },
        { kind: "end" },
      ),
    ).toBe(true);
  });
});

describe("waitForRestoreTarget", () => {
  it("finishes on the first frame at the target, before the list's own completion", () => {
    const { frames, flush, pending } = manualFrames();
    let atTarget = false;
    const reached: string[] = [];
    waitForRestoreTarget({
      scrolling: new Promise(() => {}),
      isAtTarget: () => atTarget,
      onReached: (via) => reached.push(via),
      frames,
    });
    flush();
    expect(reached).toEqual([]);
    atTarget = true;
    flush();
    expect(reached).toEqual(["viewport"]);
    expect(pending()).toBe(0);
  });

  it("falls back to the list's completion when the viewport never reads at the target", async () => {
    const { frames, flush, pending } = manualFrames();
    const reached: string[] = [];
    let complete!: () => void;
    waitForRestoreTarget({
      scrolling: new Promise<void>((resolve) => (complete = resolve)),
      isAtTarget: () => false,
      onReached: (via) => reached.push(via),
      frames,
    });
    flush();
    complete();
    await Promise.resolve();
    await Promise.resolve();
    expect(reached).toEqual(["list"]);
    expect(pending()).toBe(0);
    flush();
    expect(reached).toEqual(["list"]);
  });

  it("does nothing once cancelled", async () => {
    const { frames, flush, pending } = manualFrames();
    let reached = 0;
    const cancel = waitForRestoreTarget({
      scrolling: Promise.resolve(),
      isAtTarget: () => true,
      onReached: () => reached++,
      frames,
    });
    cancel();
    expect(pending()).toBe(0);
    flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(reached).toBe(0);
  });
});

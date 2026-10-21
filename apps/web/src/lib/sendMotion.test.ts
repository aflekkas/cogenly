import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  SEND_GLIDE_START_WAIT_MS,
  SEND_MOTION_MS,
  SEND_SPRING_FALLBACK,
  SEND_RISE_PX,
  animateScrollTop,
  cubicBezier,
  glideClockStart,
  glideOffset,
  glideProgress,
  glideToLiveEnd,
  liveEndScrollTarget,
  parseCubicBezier,
  riseKeyframes,
  scrollStep,
} from "./sendMotion";

describe("cubicBezier", () => {
  it("matches the spring's ends and front-loaded shape", () => {
    const spring = parseCubicBezier(SEND_SPRING_FALLBACK)!;
    expect(spring(0)).toBe(0);
    expect(spring(1)).toBe(1);
    // Quick to leave, a soft settle, no overshoot.
    expect(spring(0.25)).toBeGreaterThan(0.6);
    let previous = 0;
    for (let step = 1; step <= 20; step += 1) {
      const value = spring(step / 20);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(1);
      previous = value;
    }
  });

  it("is the identity for a linear curve", () => {
    const linear = cubicBezier(0, 0, 1, 1);
    expect(linear(0.3)).toBeCloseTo(0.3, 5);
    expect(linear(0.8)).toBeCloseTo(0.8, 5);
  });

  it("rejects what is not a cubic-bezier", () => {
    expect(parseCubicBezier("ease-out")).toBeNull();
    expect(parseCubicBezier("cubic-bezier(0.2, 1)")).toBeNull();
  });
});

describe("scrollStep", () => {
  it("eases from the start toward a target that may move", () => {
    expect(scrollStep(100, 500, 0)).toBe(100);
    expect(scrollStep(100, 500, 0.5)).toBe(300);
    expect(scrollStep(100, 600, 1)).toBe(600);
    expect(scrollStep(100, 500, 1.4)).toBe(500);
  });
});

describe("riseKeyframes", () => {
  it("rises straight up from below, with no scale or sideways travel", () => {
    expect(riseKeyframes(false)).toEqual([
      { opacity: 0, transform: `translateY(${SEND_RISE_PX}px)` },
      { opacity: 1, transform: "none" },
    ]);
  });

  it("only fades under reduced motion", () => {
    expect(riseKeyframes(true)).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });
});

describe("liveEndScrollTarget", () => {
  it("is the bottom of the latest content", () => {
    expect(liveEndScrollTarget({ scrollHeight: 2400, clientHeight: 800 })).toBe(1600);
  });

  it("leaves content shorter than the viewport where it is", () => {
    expect(liveEndScrollTarget({ scrollHeight: 500, clientHeight: 800 })).toBe(0);
  });
});

describe("animateScrollTop", () => {
  const frames: FrameRequestCallback[] = [];
  let clock = 0;
  const runFrame = (now: number) => {
    clock = now;
    const pending = frames.splice(0);
    for (const callback of pending) callback(now);
  };
  const stubFrames = (reduced: boolean) => {
    frames.length = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      frames.length = 0;
    });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: reduced }) });
    vi.stubGlobal("performance", { now: () => clock });
  };
  const scroller = (scrollTop: number) => ({ scrollTop, isConnected: true }) as HTMLElement;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("glides in one motion to an end that grows while the sent row measures in", () => {
    stubFrames(false);
    const node = scroller(1000);
    let end = 1000;
    const done = vi.fn();
    animateScrollTop(node, () => end, { onDone: done });
    const positions: number[] = [];
    for (let now = 0; now <= 32 + SEND_MOTION_MS + 16; now += 16) {
      if (now === 32) end = 1180;
      runFrame(now);
      positions.push(node.scrollTop);
    }
    expect(done).toHaveBeenCalledWith(true);
    // The clock starts once the end moves, so the first moving frame is the
    // spring's opening step, not most of the way there.
    expect(positions[2]).toBe(1000);
    expect(positions[3]! - 1000).toBeLessThan(180 * 0.5);
    expect(node.scrollTop).toBe(1180);
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]!).toBeGreaterThanOrEqual(positions[index - 1]!);
    }
  });

  it("keeps running when it starts at the end, so a row landing next frame is followed", () => {
    stubFrames(false);
    const node = scroller(400);
    let end = 400;
    const done = vi.fn();
    animateScrollTop(node, () => end, { onDone: done });
    expect(done).not.toHaveBeenCalled();
    runFrame(0);
    end = 520;
    for (let now = 16; now <= 16 + SEND_MOTION_MS + 16; now += 16) runFrame(now);
    expect(node.scrollTop).toBe(520);
    expect(done).toHaveBeenCalledWith(true);
  });

  it("jumps without animating under reduced motion", () => {
    stubFrames(true);
    const node = scroller(0);
    const done = vi.fn();
    animateScrollTop(node, () => 900, { onDone: done });
    expect(node.scrollTop).toBe(900);
    expect(done).toHaveBeenCalledWith(true);
    expect(frames).toHaveLength(0);
  });

  it("stops where it is when cancelled by the user scrolling", () => {
    stubFrames(false);
    const node = scroller(0);
    const done = vi.fn();
    const cancel = animateScrollTop(node, () => 1000, { onDone: done });
    runFrame(0);
    runFrame(48);
    const stoppedAt = node.scrollTop;
    cancel();
    runFrame(96);
    expect(node.scrollTop).toBe(stoppedAt);
    expect(done).toHaveBeenCalledWith(false);
  });
});

describe("glideClockStart", () => {
  it("waits while the sent row is not laid out", () => {
    expect(glideClockStart({ now: 40, firstFrameAt: 0, ready: false })).toBeNull();
  });

  it("starts on the frame the sent row lands", () => {
    expect(glideClockStart({ now: 33, firstFrameAt: 0, ready: true })).toBe(33);
  });

  it("starts anyway once it has waited long enough", () => {
    expect(glideClockStart({ now: SEND_GLIDE_START_WAIT_MS, firstFrameAt: 0, ready: false })).toBe(
      SEND_GLIDE_START_WAIT_MS,
    );
  });
});

describe("glideProgress", () => {
  it("holds at the start until the clock starts", () => {
    expect(glideProgress(500, null)).toBe(0);
  });

  it("starts from where the long commit frame ended, not its timestamp", () => {
    // The commit frame's timestamp is 5567 but it ran until 5614; the next
    // frame (5617) is the glide's first visible step, barely under way.
    expect(glideProgress(5617, 5614)).toBeLessThan(0.02);
    expect(glideProgress(5567, 5614)).toBe(0);
  });

  it("lands at the send motion's end", () => {
    expect(glideProgress(5614 + SEND_MOTION_MS, 5614)).toBe(1);
  });
});

describe("glideOffset", () => {
  it("draws the row where it was before the send at the start", () => {
    expect(glideOffset({ from: 528, natural: 315, eased: 0 })).toBe(213);
  });

  it("is gone once the glide lands", () => {
    expect(glideOffset({ from: 528, natural: 315, eased: 1 })).toBe(0);
  });

  it("follows the layout as it settles", () => {
    expect(glideOffset({ from: 528, natural: 320, eased: 0.5 })).toBe(104);
  });
});

describe("glideToLiveEnd", () => {
  const frames: FrameRequestCallback[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pins to the end and carries a short thread's shift over on a translate", () => {
    // The composer settling moves the thread a little before the sent row
    // lands; the clock waits for the row, not for that.
    frames.length = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    let clock = 0;
    vi.stubGlobal("performance", { now: () => clock });
    const content = {
      style: { translate: "" },
      // The content ends at the viewport's bottom, moved by its translate.
      getBoundingClientRect: () => ({ bottom: 800 + offsetOf() }),
    } as unknown as HTMLElement;
    let rowTop = 528;
    const offsetOf = () => Number.parseFloat(content.style.translate.split(" ")[1] ?? "0") || 0;
    const row = { getBoundingClientRect: () => ({ top: rowTop + offsetOf() }) } as Element;
    const node = {
      scrollTop: 0,
      clientHeight: 800,
      isConnected: true,
      getBoundingClientRect: () => ({ top: 0 }),
      // A downward translate adds to the scrollable overflow, and the glide
      // must not chase it.
      get scrollHeight() {
        return 800 + Math.max(0, offsetOf());
      },
    } as unknown as HTMLElement;
    const done = vi.fn();
    glideToLiveEnd(node, {
      content,
      reference: () => row,
      ready: () => rowTop !== 528,
      onDone: done,
    });
    const seen: number[] = [];
    for (let now = 0; now <= 16 + SEND_MOTION_MS + 16; now += 16) {
      if (now === 16) rowTop = 315;
      clock = now;
      frames.splice(0).forEach((callback) => callback(now));
      seen.push(row.getBoundingClientRect().top);
    }
    expect(node.scrollTop).toBe(0);
    expect(seen[0]).toBe(528);
    expect(seen[1]).toBe(528);
    for (let index = 2; index < seen.length; index += 1) {
      expect(seen[index]!).toBeLessThanOrEqual(seen[index - 1]!);
    }
    expect(content.style.translate).toBe("");
    expect(seen.at(-1)).toBe(315);
    expect(done).toHaveBeenCalledWith(true);
  });
});

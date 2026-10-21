import { describe, expect, it } from "vite-plus/test";

import {
  SEND_SPRING_FALLBACK,
  SEND_RISE_PX,
  cubicBezier,
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

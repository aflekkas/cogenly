import { describe, expect, it } from "vite-plus/test";

import { scrollFadeDistances } from "./scrollFadeFallback";

const metrics = {
  scrollTop: 0,
  scrollHeight: 100,
  clientHeight: 100,
  scrollLeft: 0,
  scrollWidth: 100,
  clientWidth: 100,
};

describe("scrollFadeDistances", () => {
  it("shows no fade on a scroller that does not overflow", () => {
    expect(scrollFadeDistances(metrics)).toEqual({ startY: 0, endY: 0, startX: 0, endX: 0 });
  });

  it("fades only the far edge before the first scroll", () => {
    expect(scrollFadeDistances({ ...metrics, scrollHeight: 400 })).toMatchObject({
      startY: 0,
      endY: 300,
    });
  });

  it("drops the far fade once scrolled to the end", () => {
    expect(scrollFadeDistances({ ...metrics, scrollHeight: 400, scrollTop: 300 })).toMatchObject({
      startY: 300,
      endY: 0,
    });
  });

  it("ignores elastic overscroll past either edge", () => {
    expect(scrollFadeDistances({ ...metrics, scrollHeight: 400, scrollTop: -20 })).toMatchObject({
      startY: 0,
      endY: 320,
    });
  });

  it("reads right-to-left scroll offsets by magnitude", () => {
    expect(scrollFadeDistances({ ...metrics, scrollWidth: 300, scrollLeft: -50 })).toMatchObject({
      startX: 50,
      endX: 150,
    });
  });
});

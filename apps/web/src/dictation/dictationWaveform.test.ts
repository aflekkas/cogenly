import { describe, expect, it } from "vite-plus/test";

import { DictationWaveform, WAVEFORM_SLOT_MS, waveformLevel } from "./dictationWaveform";

const FRAME_MS = 1000 / 60;

function run(waveform: DictationWaveform, level: number, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) waveform.step(level, FRAME_MS);
}

describe("waveformLevel", () => {
  it("rests at 0 on room noise and reaches 1 at full scale", () => {
    expect(waveformLevel(0)).toBe(0);
    expect(waveformLevel(0.1)).toBe(0);
    expect(waveformLevel(0.5)).toBeGreaterThan(0.5);
    expect(waveformLevel(1)).toBe(1);
  });
});

describe("DictationWaveform", () => {
  it("stays flat through silence and noise", () => {
    const waveform = new DictationWaveform(4);
    run(waveform, 0.1, 1000);
    expect(Array.from(waveform.bars)).toEqual([0, 0, 0, 0]);
  });

  it("raises the newest bar within a few frames of speech", () => {
    const waveform = new DictationWaveform(4);
    run(waveform, 0.8, 4 * FRAME_MS);
    expect(waveform.bars[3]).toBeGreaterThan(0.6);
    expect(waveform.bars[0]).toBe(0);
  });

  it("scrolls a burst of speech left as history, then clears it", () => {
    const waveform = new DictationWaveform(4);
    run(waveform, 0.8, WAVEFORM_SLOT_MS - FRAME_MS);
    const peak = waveform.bars[3]!;
    run(waveform, 0, 2 * WAVEFORM_SLOT_MS);
    // The burst kept its height two bars to the left; the live bar fell back.
    expect(waveform.bars[1]).toBeGreaterThanOrEqual(peak);
    expect(waveform.bars[3]).toBeLessThan(0.1);
    run(waveform, 0, 8 * WAVEFORM_SLOT_MS);
    expect(Math.max(...waveform.bars)).toBeLessThan(0.01);
  });

  it("treats a stalled frame as a short step instead of replaying it", () => {
    const waveform = new DictationWaveform(4);
    waveform.step(0.8, 10_000);
    // One step scrolls at most one slot, so the burst is still on the newest bar.
    expect(waveform.bars[3]).toBeGreaterThan(0.5);
  });
});

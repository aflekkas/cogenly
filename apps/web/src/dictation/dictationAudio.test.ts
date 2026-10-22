import { describe, expect, it } from "vite-plus/test";

import { downsample, encodePcm16, speechLevel } from "./dictationAudio";

describe("encodePcm16", () => {
  it("writes little-endian 16-bit samples and clips out-of-range input", () => {
    const bytes = encodePcm16(new Float32Array([0, 1, -1, 0.5, 2]));
    expect(bytes.length).toBe(10);
    const view = new DataView(bytes.buffer);
    const samples = [0, 1, 2, 3, 4].map((index) => view.getInt16(index * 2, true));
    expect(samples).toEqual([0, 32767, -32768, 16383, 32767]);
  });
});

describe("downsample", () => {
  it("averages each output frame's span of input", () => {
    const input = new Float32Array([0, 0.3, 0.6, 1, 1, 1]);
    expect(Array.from(downsample(input, 48_000, 16_000))).toEqual([
      expect.closeTo(0.3),
      expect.closeTo(1),
    ]);
  });

  it("passes input at or below the target rate through", () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(downsample(input, 16_000, 16_000)).toBe(input);
  });
});

describe("speechLevel", () => {
  it("maps silence to 0, speech into the middle and a full-scale signal to 1", () => {
    expect(speechLevel(new Float32Array(512))).toBe(0);
    const speech = speechLevel(new Float32Array(512).fill(0.05));
    expect(speech).toBeGreaterThan(0.3);
    expect(speech).toBeLessThan(0.8);
    expect(speechLevel(new Float32Array(512).fill(1))).toBe(1);
  });
});

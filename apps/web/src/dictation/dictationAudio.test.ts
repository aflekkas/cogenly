import { describe, expect, it } from "vite-plus/test";

import { downsample, encodeWav, speechLevel } from "./dictationAudio";

describe("encodeWav", () => {
  it("writes a mono 16-bit PCM file AVAudioFile can open", () => {
    const bytes = encodeWav([new Float32Array([0, 1, -1]), new Float32Array([0.5, 2])], 16_000);
    const view = new DataView(bytes.buffer);
    const ascii = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(10);
    // Out-of-range input clips instead of wrapping.
    const samples = [0, 1, 2, 3, 4].map((index) => view.getInt16(44 + index * 2, true));
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

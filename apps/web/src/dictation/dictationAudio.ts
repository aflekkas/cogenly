/** Sample rate the speech helper receives; speech models gain nothing above 16 kHz. */
export const DICTATION_SAMPLE_RATE = 16_000;

/** Box-filters `input` down to `outputRate`. Rates at or below it pass through. */
export function downsample(input: Float32Array, inputRate: number, outputRate: number) {
  if (inputRate <= outputRate) return input;
  const ratio = inputRate / outputRate;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let sample = start; sample < end; sample += 1) sum += input[sample]!;
    output[index] = end > start ? sum / (end - start) : 0;
  }
  return output;
}

/** Little-endian 16-bit PCM bytes of `samples`, the format the speech helper streams. */
export function encodePcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]!));
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}

/**
 * Perceived loudness in [0, 1] for the recording indicator. Speech RMS sits
 * around 0.02 to 0.2, so the curve is logarithmic over roughly -50 to -10 dBFS.
 */
export function speechLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / samples.length);
  if (rms <= 0) return 0;
  const decibels = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (decibels + 50) / 40));
}

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

/** A mono 16-bit PCM WAV file of `chunks`, which AVAudioFile reads directly. */
export function encodeWav(chunks: ReadonlyArray<Float32Array>, sampleRate: number): Uint8Array {
  const frameCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(44 + frameCount * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + frameCount * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, frameCount * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
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

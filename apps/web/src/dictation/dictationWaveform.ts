/** Bars in the composer's recording waveform, oldest on the left. */
export const WAVEFORM_BAR_COUNT = 10;
/** How often the waveform scrolls one bar; each bar holds the loudest level of its slot. */
export const WAVEFORM_SLOT_MS = 80;
// Room tone and mic hiss sit at the bottom of speechLevel's range; gating them
// keeps the bars resting flat until someone speaks.
const NOISE_GATE = 0.14;
// How quickly a bar grows to its slot's peak; long enough to read as motion, not a jump.
const RISE_MS = 45;
// A frame after a stall (background tab, breakpoint) jumps instead of replaying.
const MAX_STEP_MS = 100;

/** Speech level in [0, 1] with the noise floor removed and quiet speech lifted. */
export function waveformLevel(level: number): number {
  const gated = (Math.min(1, Math.max(0, level)) - NOISE_GATE) / (1 - NOISE_GATE);
  return gated <= 0 ? 0 : Math.sqrt(gated);
}

/**
 * A scrolling level history for the recording indicator. `step` runs once per
 * animation frame with the current input level; `bars` holds each bar's smoothed
 * height in [0, 1]. The newest bar tracks the voice live, then scrolls left.
 */
export class DictationWaveform {
  readonly bars: Float32Array;
  private readonly targets: Float32Array;
  private slotElapsedMs = 0;

  constructor(readonly count = WAVEFORM_BAR_COUNT) {
    this.bars = new Float32Array(count);
    this.targets = new Float32Array(count);
  }

  step(level: number, elapsedMs: number): void {
    const dt = Math.min(MAX_STEP_MS, Math.max(0, elapsedMs));
    const last = this.count - 1;
    this.slotElapsedMs += dt;
    if (this.slotElapsedMs >= WAVEFORM_SLOT_MS) {
      this.slotElapsedMs %= WAVEFORM_SLOT_MS;
      // Heights scroll with their bars so the history slides instead of re-easing.
      this.bars.copyWithin(0, 1);
      this.targets.copyWithin(0, 1);
      // A fresh slot grows from the baseline rather than smearing the last one.
      this.bars[last] = 0;
      this.targets[last] = 0;
    }
    this.targets[last] = Math.max(this.targets[last]!, waveformLevel(level));
    for (let index = 0; index < this.count; index += 1) {
      // Targets only grow within a slot, so bars only ever ease upward toward them.
      const current = this.bars[index]!;
      this.bars[index] = current + (this.targets[index]! - current) * (1 - Math.exp(-dt / RISE_MS));
    }
  }

  reset(): void {
    this.bars.fill(0);
    this.targets.fill(0);
    this.slotElapsedMs = 0;
  }
}

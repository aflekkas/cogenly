import { useEffect, useRef } from "react";

import { DictationWaveform, WAVEFORM_BAR_COUNT } from "../../dictation/dictationWaveform";
import { cn } from "../../lib/utils";

const BAR_MIN_PX = 2;
const BAR_MAX_PX = 16;
// Under reduced motion the bars hold one calm shape and only their opacity follows the voice.
const STATIC_SHAPE = [0.15, 0.3, 0.5, 0.35, 0.7, 0.5, 0.85, 0.45, 0.6, 0.3];
const BARS = Array.from({ length: WAVEFORM_BAR_COUNT }, (_, index) => ({
  key: index,
  // The history fades toward its oldest end, so the newest bar reads as "now".
  opacity: 0.3 + (0.7 * index) / (WAVEFORM_BAR_COUNT - 1),
}));

function barHeight(value: number) {
  return `${(BAR_MIN_PX + value * (BAR_MAX_PX - BAR_MIN_PX)).toFixed(2)}px`;
}

/**
 * The live waveform inside the dictation control while recording. Bars are
 * right-aligned so a narrower control clips the oldest history and keeps the
 * newest bars. Frames write bar heights straight to the DOM, so the composer
 * never re-renders, and the loop stops with the recording.
 */
export function ComposerDictationWaveform({
  recording,
  readLevel,
}: {
  readonly recording: boolean;
  readonly readLevel: () => number;
}) {
  const barsRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const container = barsRef.current;
    if (!recording || !container) return;
    const bars = Array.from(container.children, (child) => child as HTMLElement);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const waveform = new DictationWaveform(bars.length);
    const drawn = new Float32Array(bars.length);
    bars.forEach((bar, index) => {
      bar.style.height = barHeight(reduceMotion ? (STATIC_SHAPE[index] ?? 0) : 0);
    });
    let drawnOpacity = -1;
    let previous = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      waveform.step(readLevel(), now - previous);
      previous = now;
      if (reduceMotion) {
        const opacity = 0.45 + 0.55 * waveform.bars[bars.length - 1]!;
        if (Math.abs(opacity - drawnOpacity) > 0.01) {
          container.style.opacity = opacity.toFixed(3);
          drawnOpacity = opacity;
        }
      } else {
        // Settled bars are skipped, so silence costs no style writes.
        for (let index = 0; index < bars.length; index += 1) {
          const value = waveform.bars[index]!;
          if (Math.abs(value - drawn[index]!) < 0.004) continue;
          drawn[index] = value;
          bars[index]!.style.height = barHeight(value);
        }
      }
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      container.style.removeProperty("opacity");
    };
  }, [readLevel, recording]);

  return (
    <span
      ref={barsRef}
      aria-hidden
      className={cn(
        "flex h-4 w-10 shrink-0 items-center justify-between transition-opacity duration-(--motion-duration-fast) ease-out",
        recording ? "opacity-100" : "opacity-0",
      )}
    >
      {BARS.map((bar) => (
        <span
          key={bar.key}
          className="w-0.5 rounded-full bg-current"
          style={{ height: BAR_MIN_PX, opacity: bar.opacity }}
        />
      ))}
    </span>
  );
}

import { useEffect, useRef, useState } from "react";

/** The pixel button's ramps (pixelButton.css): the ember brand, the red stop, the flat idle grey. */
export type PixelTone = "brand" | "danger" | "idle";

/**
 * Plays the pixel button's tone change. Render it inside any `.pixel-button`
 * and pass the tone the button shows now: when that changes, the old tone
 * steps out over the new one (the splash's rising exit, 300ms) and the layer
 * removes itself. A change that lands mid-exit restarts the exit from the
 * tone the user last saw at rest, so a flicker through a third tone (send,
 * busy, stop) still reads as one change. The first render and a `resetKey`
 * change (a thread switch) show the new tone at once.
 */
export function PixelToneGhost({ tone, resetKey }: { tone: PixelTone; resetKey?: unknown }) {
  const [ghost, setGhost] = useState<{ from: PixelTone; run: number } | null>(null);
  const seen = useRef({ tone, resetKey });
  useEffect(() => {
    const previous = seen.current;
    seen.current = { tone, resetKey };
    if (previous.resetKey !== resetKey) {
      setGhost(null);
      return;
    }
    if (previous.tone === tone) return;
    setGhost((current) => {
      const from = current?.from ?? previous.tone;
      return from === tone ? null : { from, run: (current?.run ?? 0) + 1 };
    });
  }, [tone, resetKey]);
  if (!ghost) return null;
  return (
    <span
      key={ghost.run}
      aria-hidden="true"
      className="pixel-button-ghost"
      data-tone-from={ghost.from}
      onAnimationEnd={() => setGhost(null)}
    />
  );
}

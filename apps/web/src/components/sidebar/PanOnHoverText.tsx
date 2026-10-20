import { useEffect, useRef, useState, type ReactNode } from "react";

// Slow enough to read along; the duration scales with how far the text moves.
const PAN_SPEED_PX_PER_SECOND = 35;
const PAN_DELAY_MS = 300;
// The fade-truncate edge (1.5rem). Panning this much past the overflow lands
// the last character clear of the right fade.
const PAN_FADE_PX = 24;
const PANNED_MASK =
  "linear-gradient(to right, transparent, black 1.5rem, black calc(100% - 1.5rem), transparent)";
const RETURN_TRANSITION = "transform var(--motion-duration-slow) var(--motion-ease-standard)";

/**
 * One line of text that, when it overflows, pans left once while its row is
 * hovered so the whole of it can be read, then slides back on leave. The pan
 * is a single CSS transform transition (no animation frames), and it is
 * skipped under prefers-reduced-motion. While panned, the edge fade sits on
 * both sides.
 *
 * Pass the truncation classes (`fade-truncate`, `min-w-0 flex-1`, colors) in
 * `className`. The hover target is the nearest row control (`role="button"`,
 * button, link), or the parent element.
 */
export function PanOnHoverText(props: { className?: string | undefined; children: ReactNode }) {
  const outerRef = useRef<HTMLSpanElement>(null);
  const [panPx, setPanPx] = useState(0);
  const [masked, setMasked] = useState(false);

  useEffect(() => {
    const outer = outerRef.current;
    const root =
      outer?.parentElement?.closest<HTMLElement>('[role="button"], button, a') ??
      outer?.parentElement;
    if (!outer || !root) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let panned = false;
    const enter = () => {
      if (timer !== null) clearTimeout(timer);
      // Measured after the delay so hover-only row affordances have settled
      // the title's width first.
      timer = setTimeout(() => {
        timer = null;
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        const overflow = outer.scrollWidth - outer.clientWidth;
        if (overflow <= 1) return;
        panned = true;
        setMasked(true);
        setPanPx(overflow + PAN_FADE_PX);
      }, PAN_DELAY_MS);
    };
    const leave = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (!panned) return;
      panned = false;
      setPanPx(0);
    };
    root.addEventListener("pointerenter", enter);
    root.addEventListener("pointerleave", leave);
    return () => {
      if (timer !== null) clearTimeout(timer);
      root.removeEventListener("pointerenter", enter);
      root.removeEventListener("pointerleave", leave);
    };
  }, []);

  const settle = () => {
    if (panPx === 0) setMasked(false);
  };

  return (
    <span
      ref={outerRef}
      className={props.className}
      style={masked ? { maskImage: PANNED_MASK, WebkitMaskImage: PANNED_MASK } : undefined}
    >
      <span
        className="inline-block"
        style={
          panPx > 0
            ? {
                transform: `translateX(-${panPx}px)`,
                transition: `transform ${Math.round((panPx / PAN_SPEED_PX_PER_SECOND) * 1000)}ms ease-in-out`,
              }
            : masked
              ? { transition: RETURN_TRANSITION }
              : undefined
        }
        onTransitionEnd={settle}
        onTransitionCancel={settle}
      >
        {props.children}
      </span>
    </span>
  );
}

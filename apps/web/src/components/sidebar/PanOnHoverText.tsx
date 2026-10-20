import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

// Slow enough to read along; the duration scales with how far the text moves.
const PAN_SPEED_PX_PER_SECOND = 35;
const PAN_DELAY_MS = 300;
// The pan-text edge fade (1.5rem). Panning this much past the overflow lands
// the last character clear of the right fade.
const PAN_FADE_PX = 24;

/**
 * One line of text that, when it truly overflows, pans left once while its
 * row is hovered so the whole of it can be read, then slides back on leave.
 * The pan is a single CSS transition of `--pan-x` (see the pan-text utility),
 * skipped under prefers-reduced-motion. The left edge fades only as far as
 * the text has moved, so the start of a title is never clipped at rest; the
 * right edge fades at the end, or under a row's hover actions when the row
 * sets `--pan-end-inset-target`.
 *
 * Pass layout and color classes (`min-w-0 flex-1`, colors) in `className`;
 * truncation is built in. The hover target is the nearest row control
 * (`role="button"`, button, link), or the parent element.
 */
export function PanOnHoverText(props: { className?: string | undefined; children: ReactNode }) {
  const clipRef = useRef<HTMLSpanElement>(null);
  const [panPx, setPanPx] = useState(0);

  useEffect(() => {
    const clip = clipRef.current;
    const outer = clip?.parentElement;
    const root =
      outer?.parentElement?.closest<HTMLElement>('[role="button"], button, a') ??
      outer?.parentElement;
    if (!clip || !root) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const enter = () => {
      if (timer !== null) clearTimeout(timer);
      // Measured after the delay so hover-only row affordances have settled.
      timer = setTimeout(() => {
        timer = null;
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        const overflow = clip.scrollWidth - clip.clientWidth;
        if (overflow <= 1) return;
        // Text under a row's hover actions is hidden too, so the pan also
        // carries the end clear of them.
        const endInset =
          Number.parseFloat(getComputedStyle(clip).getPropertyValue("--pan-end-inset-target")) || 0;
        setPanPx(overflow + PAN_FADE_PX + endInset);
      }, PAN_DELAY_MS);
    };
    const leave = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
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

  const panStyle =
    panPx > 0
      ? ({
          "--pan-x": `${panPx}px`,
          "--pan-duration": `${Math.round((panPx / PAN_SPEED_PX_PER_SECOND) * 1000)}ms`,
          "--pan-ease": "ease-in-out",
        } as CSSProperties)
      : undefined;

  return (
    <span className={props.className}>
      <span ref={clipRef} className="pan-text" style={panStyle}>
        <span>{props.children}</span>
      </span>
    </span>
  );
}

/**
 * Scroll-edge fades for browsers without scroll-driven animations (see
 * scroll-fade in index.css). One passive, capture-phase listener per event
 * covers every `scroll-fade*` scroller, including ScrollArea viewports: it
 * writes the same mask stops the scroll timelines would, batched to one write
 * per frame. A scroller is measured when it scrolls or when the pointer or
 * focus enters it, so its far-edge fade shows before the first scroll.
 * Chromium, and so the desktop app, never installs it. Idempotent.
 */
export function installScrollFadeFallback(): void {
  if (installed) return;
  installed = true;
  if (typeof CSS === "undefined" || CSS.supports("animation-timeline: scroll()")) return;
  const pending = new Set<HTMLElement>();
  let frame = 0;
  const flush = () => {
    frame = 0;
    for (const element of pending) writeScrollFadeStops(element);
    pending.clear();
  };
  const schedule = (element: HTMLElement) => {
    pending.add(element);
    if (frame === 0) frame = requestAnimationFrame(flush);
  };
  const scheduleFrom = (target: EventTarget | null) => {
    let element =
      target instanceof Element ? target.closest<HTMLElement>(SCROLL_FADE_SELECTOR) : null;
    while (element) {
      schedule(element);
      element = element.parentElement?.closest<HTMLElement>(SCROLL_FADE_SELECTOR) ?? null;
    }
  };
  const options = { capture: true, passive: true } as const;
  document.addEventListener(
    "scroll",
    (event) => {
      if (event.target instanceof HTMLElement && event.target.matches(SCROLL_FADE_SELECTOR)) {
        schedule(event.target);
      }
    },
    options,
  );
  document.addEventListener("pointerover", (event) => scheduleFrom(event.target), options);
  document.addEventListener("focusin", (event) => scheduleFrom(event.target), options);
}

/** How far a scroller can still travel toward each edge, in px. */
export function scrollFadeDistances(metrics: {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrollLeft: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}) {
  const left = Math.abs(metrics.scrollLeft);
  return {
    startY: Math.max(0, metrics.scrollTop),
    endY: Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop),
    startX: Math.max(0, left),
    endX: Math.max(0, metrics.scrollWidth - metrics.clientWidth - left),
  };
}

function writeScrollFadeStops(element: HTMLElement) {
  const distances = scrollFadeDistances(element);
  // Subpixel layouts leave a fraction of travel at a fully scrolled edge.
  const stop = (size: string, distance: number) =>
    distance < 1 ? "0px" : `min(${size}, ${Math.round(distance)}px)`;
  const { style } = element;
  style.setProperty(
    "--scroll-fade-start-y",
    stop("var(--scroll-fade-start-size, var(--scroll-fade-size))", distances.startY),
  );
  style.setProperty("--scroll-fade-end-y", stop("var(--scroll-fade-size)", distances.endY));
  style.setProperty("--scroll-fade-start-x", stop("var(--scroll-fade-size)", distances.startX));
  style.setProperty("--scroll-fade-end-x", stop("var(--scroll-fade-size)", distances.endX));
}

// Markdown code blocks and tables apply the utility from index.css and agents.css.
const SCROLL_FADE_SELECTOR =
  ".scroll-fade, .scroll-fade-y, .scroll-fade-x, .chat-markdown pre, .agent-markdown pre, .agent-markdown table";

let installed = false;

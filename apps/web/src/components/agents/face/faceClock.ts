/**
 * One requestAnimationFrame loop shared by every mounted agent face.
 *
 * Faces subscribe only while they are on screen, and the loop runs only while it
 * has subscribers and the document is visible. The clock advances by the frame
 * delta, capped, so a hidden tab or a stalled frame resumes where it left off
 * instead of jumping ahead. The engine is a pure function of time, so a shared
 * clock is all a face needs.
 */

type FrameListener = (now: number) => void;

const MAX_FRAME_SECONDS = 0.064;

const listeners = new Set<FrameListener>();
let clock = 0;
let lastFrameMs = 0;
let frameHandle = 0;
let visibilityBound = false;

export function faceClockNow(): number {
  return clock;
}

function tick(frameMs: number) {
  frameHandle = 0;
  clock += lastFrameMs ? Math.min((frameMs - lastFrameMs) / 1000, MAX_FRAME_SECONDS) : 0;
  lastFrameMs = frameMs;
  for (const listener of listeners) listener(clock);
  schedule();
}

function schedule() {
  if (frameHandle || listeners.size === 0 || document.hidden) return;
  frameHandle = requestAnimationFrame(tick);
}

function stop() {
  if (frameHandle) cancelAnimationFrame(frameHandle);
  frameHandle = 0;
  lastFrameMs = 0;
}

function onVisibilityChange() {
  if (document.hidden) stop();
  else schedule();
}

export function subscribeFaceClock(listener: FrameListener): () => void {
  if (!visibilityBound) {
    document.addEventListener("visibilitychange", onVisibilityChange);
    visibilityBound = true;
  }
  listeners.add(listener);
  schedule();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

type VisibilityListener = (visible: boolean) => void;

const visibilityListeners = new WeakMap<Element, VisibilityListener>();
let observer: IntersectionObserver | null = null;

/** One IntersectionObserver for all faces; `onChange` fires as a face enters or leaves the viewport. */
export function observeFaceVisibility(element: Element, onChange: VisibilityListener): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onChange(true);
    return () => {};
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) visibilityListeners.get(entry.target)?.(entry.isIntersecting);
  });
  visibilityListeners.set(element, onChange);
  observer.observe(element);
  return () => {
    visibilityListeners.delete(element);
    observer?.unobserve(element);
  };
}

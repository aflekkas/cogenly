/**
 * The pointer position every on-screen agent face looks toward.
 *
 * One passive window `pointermove` listener, coalesced to one notification per
 * animation frame, and bound only while some face is subscribed. Listeners get
 * viewport coordinates, or `null` once the pointer leaves the window. Touch is
 * ignored: a finger has no hover, so faces keep their own gaze.
 */

export interface FacePointer {
  x: number;
  y: number;
}

type PointerListener = (pointer: FacePointer | null) => void;

const listeners = new Set<PointerListener>();
let latest: FacePointer | null = null;
let frameHandle = 0;

function flush() {
  frameHandle = 0;
  for (const listener of listeners) listener(latest);
}

function schedule() {
  if (!frameHandle) frameHandle = requestAnimationFrame(flush);
}

function onPointerMove(event: PointerEvent) {
  if (event.pointerType === "touch") return;
  latest = { x: event.clientX, y: event.clientY };
  schedule();
}

function onPointerOut(event: PointerEvent) {
  if (event.relatedTarget || !latest) return;
  latest = null;
  schedule();
}

function onBlur() {
  if (!latest) return;
  latest = null;
  schedule();
}

function bind() {
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerout", onPointerOut, { passive: true });
  window.addEventListener("blur", onBlur);
}

function unbind() {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerout", onPointerOut);
  window.removeEventListener("blur", onBlur);
  if (frameHandle) cancelAnimationFrame(frameHandle);
  frameHandle = 0;
  latest = null;
}

/** Subscribes to the shared pointer; a known position is delivered right away. */
export function subscribeFacePointer(listener: PointerListener): () => void {
  if (listeners.size === 0) bind();
  listeners.add(listener);
  if (latest) listener(latest);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) unbind();
  };
}

import { findRowWipe, rowWipeKeyframes, type RowWipe } from "./Sidebar.motion.logic";

// Matches --motion-duration-base and ease-standard in index.css.
const motionTiming = { duration: 220, easing: "cubic-bezier(0.32, 0.72, 0, 1)" };
// A project filter change or a bulk snooze swaps a large part of the list at
// once. Fades are the expensive part: every removed row gets a deep clone and
// every clone and entering row gets its own animation, and the layout reads
// in between force synchronous reflows. Translating displaced rows is cheap,
// so only the fade count decides whether an update animates.
const MAX_FADED_ROWS_PER_UPDATE = 40;

/** `top` is where the row's layout box sits on screen (window coordinates, its
 * own running transforms excluded), so a list that shifts as a whole between
 * updates (a list restoring its scroll position, say) moves only the rows
 * that actually moved on screen. */
type RowPosition = { top: number; left: number; width: number; height: number };

function progress(animation: Animation) {
  return animation.playState === "finished"
    ? 1
    : (animation.effect?.getComputedTiming().progress ?? 0);
}

/** Animate rows between their layout positions. The list must be
 * positioned so every direct child's offsetTop has the same origin.
 *
 * A row that leaves or joins fades where it stands and never travels; a clip
 * closes or opens its space from the side the neighbours move into
 * (Sidebar.motion.logic.ts), so the rows beside it slide once and nothing
 * crosses the rows that stay. */
export function createSidebarListMotion(parent: HTMLUListElement) {
  let positions: Map<HTMLElement, RowPosition> | null = null;
  // Window y of the parent's offset origin, read once per update.
  const frameTop = () => parent.getBoundingClientRect().top + parent.clientTop;
  let disposed = false;
  const reducedMotion = parent.ownerDocument.defaultView?.matchMedia(
    "(prefers-reduced-motion: reduce)",
  );
  const running = new Map<HTMLElement, { animation: Animation; offset: number }>();
  // `clip` is the entering row's wipe, which ends with the fade.
  const entering = new Map<HTMLElement, { animation: Animation; clip: Animation | null }>();
  const exiting = new Map<HTMLElement, Animation>();

  const remainingOffset = (node: HTMLElement) => {
    const current = running.get(node);
    return current ? current.offset * (1 - progress(current.animation)) : 0;
  };
  const endEntry = (node: HTMLElement) => {
    const entry = entering.get(node);
    if (!entry) return;
    entry.animation.cancel();
    entry.clip?.cancel();
    entering.delete(node);
  };
  const clearFades = () => {
    for (const node of entering.keys()) endEntry(node);
    for (const animation of exiting.values()) animation.cancel();
    for (const node of exiting.keys()) node.remove();
    exiting.clear();
  };
  const fadeOut = (
    node: HTMLElement,
    position: RowPosition,
    wipe: RowWipe | null,
    origin: number,
  ) => {
    if (position.height === 0) return;
    // React owns the removed row; only a noninteractive copy stays for the fade.
    const clone = node.cloneNode(true) as HTMLElement;
    for (const element of [clone, ...clone.querySelectorAll("*")]) {
      for (const attribute of Array.from(element.attributes)) {
        if (
          (attribute.name === "id" && element.namespaceURI !== "http://www.w3.org/2000/svg") ||
          attribute.name === "data-thread-item" ||
          attribute.name === "data-thread-selection-safe" ||
          attribute.name === "data-testid"
        ) {
          element.removeAttribute(attribute.name);
        }
      }
    }
    clone.setAttribute("aria-hidden", "true");
    clone.inert = true;
    Object.assign(clone.style, {
      position: "absolute",
      // Where the row was on screen, in the parent's current coordinates.
      top: `${position.top + remainingOffset(node) - origin}px`,
      left: `${position.left}px`,
      width: `${position.width}px`,
      height: `${position.height}px`,
      margin: "0",
      boxSizing: "border-box",
      contentVisibility: "visible",
      transform: "none",
      transition: "none",
      pointerEvents: "none",
    });
    parent.append(clone);
    const entry = entering.get(node);
    const entryProgress = entry ? progress(entry.animation) : 1;
    const animation = clone.animate([{ opacity: entryProgress }, { opacity: 0 }], motionTiming);
    const clip = wipe && rowWipeKeyframes(wipe, position.height, "out");
    if (clip) clone.animate(clip, motionTiming);
    exiting.set(clone, animation);
    animation.addEventListener(
      "finish",
      () => {
        clone.remove();
        exiting.delete(clone);
      },
      { once: true },
    );
  };
  const fadeIn = (node: HTMLElement, position: RowPosition, wipe: RowWipe | null) => {
    const animation = node.animate([{ opacity: 0 }, { opacity: 1 }], motionTiming);
    const keyframes = wipe && rowWipeKeyframes(wipe, position.height, "in");
    const clip = keyframes ? node.animate(keyframes, motionTiming) : null;
    entering.set(node, { animation, clip });
    animation.addEventListener(
      "finish",
      () => {
        if (entering.get(node)?.animation === animation) entering.delete(node);
      },
      { once: true },
    );
  };

  const cancel = (node: HTMLElement) => {
    running.get(node)?.animation.cancel();
    running.delete(node);
  };
  const suspend = () => {
    for (const node of running.keys()) cancel(node);
    clearFades();
    positions = null;
  };
  const move = (node: HTMLElement, offset: number) => {
    cancel(node);
    if (offset === 0) return;
    const animation = node.animate(
      [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0px)" }],
      motionTiming,
    );
    running.set(node, { animation, offset });
    animation.addEventListener(
      "finish",
      () => {
        if (running.get(node)?.animation === animation) running.delete(node);
      },
      { once: true },
    );
  };

  const measure = (origin: number) =>
    new Map(
      Array.from(parent.children)
        .filter((node): node is HTMLElement => node instanceof HTMLElement && !exiting.has(node))
        .map((node) => [
          node,
          {
            top: origin + node.offsetTop,
            left: node.offsetLeft,
            width: node.offsetWidth,
            height: node.offsetHeight,
          },
        ]),
    );

  return {
    /** `inPlace` is for a page reveal: rows that arrive fade in where they
     * land and nothing travels, so the list reads as having grown rather
     * than rearranged. Opacity-only fades are cheap, so the fade cap is off. */
    update(animate: boolean, options?: { readonly inPlace?: boolean }) {
      const inPlace = options?.inPlace === true;
      if (disposed) return;
      const origin = frameTop();
      const next = measure(origin);
      let fadeCount = 0;
      if (positions !== null) {
        for (const [node, position] of positions) {
          if (!next.has(node) && position.height > 0) fadeCount++;
        }
        for (const [node, position] of next) {
          if (!positions.has(node) && position.height > 0) fadeCount++;
        }
      }
      // Reduced motion keeps the fades and drops every translate and clip; so does a reveal.
      const reduced = reducedMotion?.matches === true || inPlace;
      const shouldAnimate =
        animate && positions !== null && (inPlace || fadeCount <= MAX_FADED_ROWS_PER_UPDATE);
      const movedDelta = new Map<HTMLElement, number>();
      const nextOrder = [...next.keys()];
      const oldOrder = positions === null ? [] : [...positions.keys()];
      const displacement = (node: HTMLElement) => movedDelta.get(node) ?? remainingOffset(node);
      if (!shouldAnimate) clearFades();
      else {
        // The rows that stay and moved, by how far they have to travel from
        // where they were drawn.
        for (const [node, position] of next) {
          const previousTop = positions!.get(node)?.top;
          if (previousTop === undefined || previousTop === position.top) continue;
          movedDelta.set(node, previousTop + remainingOffset(node) - position.top);
        }
        for (const [index, node] of oldOrder.entries()) {
          if (next.has(node)) continue;
          // A leaving row fades where it stands while a clip closes its space
          // from the side its neighbours move into; it never slides itself.
          const wipe = reduced
            ? null
            : findRowWipe({
                order: oldOrder,
                index,
                geometry: (other) => positions!.get(other),
                isNeighbour: (other) => next.has(other),
                displacement,
              });
          fadeOut(node, positions!.get(node)!, wipe, origin);
        }
      }
      for (const node of entering.keys()) {
        if (!next.has(node)) endEntry(node);
      }
      for (const node of running.keys()) {
        if (!shouldAnimate || !next.has(node)) cancel(node);
      }
      if (shouldAnimate) {
        for (const [index, node] of nextOrder.entries()) {
          const position = next.get(node)!;
          const previousTop = positions!.get(node)?.top;
          if (previousTop === undefined) {
            if (position.height > 0) {
              // An arriving row fades in where it lands, its space opening from
              // the side its neighbours move away from.
              const wipe = reduced
                ? null
                : findRowWipe({
                    order: nextOrder,
                    index,
                    geometry: (other) => next.get(other),
                    isNeighbour: (other) => positions!.has(other),
                    displacement,
                  });
              fadeIn(node, position, wipe);
            }
            continue;
          }
          const delta = movedDelta.get(node);
          // Computed progress includes the effect's easing. Only our own
          // translate is carried forward.
          if (delta !== undefined && !reduced) move(node, delta);
        }
      }
      positions = next;
    },
    /** Rows that moved on their own (a fold's height motion settling)
     * become the positions the next update moves from. Running animations
     * carry on; nothing new animates. */
    remeasure() {
      if (disposed || positions === null) return;
      positions = measure(frameTop());
    },
    /** The whole list fades in once where it stands, for a swap too large to
     * animate row by row (a project filter). One animation on the list, no
     * clones; call it after an `update(false)`. */
    fadeInList() {
      if (disposed) return;
      parent.animate([{ opacity: 0 }, { opacity: 1 }], motionTiming);
    },
    suspend,
    dispose() {
      suspend();
      disposed = true;
    },
  };
}

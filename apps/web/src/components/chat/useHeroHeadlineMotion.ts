import { useLayoutEffect, useRef, type RefObject } from "react";

import { PANEL_ANIMATION_DURATION } from "~/panelAnimations";
import { observeResize } from "~/lib/observeResize";
import { PANEL_MOTION_EASING } from "~/lib/panelFlip";

import { settleFadeSwap } from "./StateTransition";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const STEP_ANIMATION_ID = "hero-headline-step";
const STACK_ANIMATION_ID = "hero-headline-stack";
const PIECE_ANIMATION_ID = "hero-headline-piece";
/** The heading's own line, and the chat project tail that may follow it. */
const GREETING_SELECTOR = "[data-hero-greeting]";
const SUFFIX_SELECTOR = "[data-hero-project-suffix]";
const SUFFIX_TEXT_SELECTOR = "[data-hero-suffix-shown]";
/** Work's "<project> / <repository>?", which follows the lead or wraps whole under it. */
const BREADCRUMB_SELECTOR = "[data-hero-breadcrumb]";
/** The Work sentence's parts that move on their own (WorkHeroSentence). */
const PIECE_SELECTOR = "[data-hero-piece]";
/** Pieces whose content changes; the rest only move. */
const SWAPPING_PIECES = new Set(["project", "repository"]);
/** Set on the heading while the project tail sits on a line of its own. */
const STACKED_ATTRIBUTE = "data-stacked";
/** Markers and ids a leaving copy must not repeat. */
const COPY_STRIPPED_ATTRIBUTES = [
  "id",
  "data-hero-project-suffix",
  "data-hero-suffix-shown",
  "data-hero-breadcrumb",
  "data-hero-piece",
  "data-hero-project-picker",
  "data-draft-project-trigger",
] as const;
/** What a leaving copy keeps of its old look. */
const FROZEN_STYLES = [
  "display",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "color",
  "opacity",
  "width",
  "textDecorationColor",
] as const;

interface Offset {
  readonly x: number;
  readonly y: number;
}

/**
 * A Work sentence piece as last laid out: its untransformed box, measured from
 * the heading's left and bottom edges so the heading moving as a whole (the
 * hero re-centring, a panel glide) never reads as a piece moving, and what it
 * showed.
 */
interface PieceSnapshot {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly key: string;
  /** How it looked, to fade out where it was when its content changes. */
  readonly copy: HTMLElement | null;
}

type Pieces = ReadonlyMap<string, PieceSnapshot>;

/**
 * The Work sentence a draft heading showed as it unmounted, for the heading
 * that replaces it in the same commit (picking a repository opens a new
 * draft). Anything left after that task was not replaced.
 */
let handoff: { readonly group: string; readonly pieces: Pieces } | null = null;

/** Where an element's bottom centre sits from the heading's, which is where the heading is anchored. */
function offsetWithin(element: HTMLElement, heading: HTMLElement): Offset {
  const box = element.getBoundingClientRect();
  const frame = heading.getBoundingClientRect();
  return {
    x: (box.left + box.right) / 2 - (frame.left + frame.right) / 2,
    y: box.bottom - frame.bottom,
  };
}

/** The scale an element is drawn at right now, mid-animation included. */
function drawnScale(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform;
  if (!transform || transform === "none") return 1;
  return new DOMMatrixReadOnly(transform).a || 1;
}

/** How far a piece's own glide has it drawn from its layout box, on screen. */
function pieceShift(element: HTMLElement, scale: number): Offset {
  if (!element.getAnimations().some((animation) => animation.id === PIECE_ANIMATION_ID)) {
    return { x: 0, y: 0 };
  }
  const transform = getComputedStyle(element).transform;
  if (!transform || transform === "none") return { x: 0, y: 0 };
  const matrix = new DOMMatrixReadOnly(transform);
  return { x: matrix.e * scale, y: matrix.f * scale };
}

/** What a piece shows, so a changed name or icon crossfades and a moved one only glides. */
function pieceKey(element: HTMLElement): string {
  const images = [...element.querySelectorAll("img")].map((image) => image.src).join(" ");
  return `${element.textContent ?? ""}|${images}`;
}

/** Holds the first keyframe through the frame that committed the change, then plays. */
function playFromNextFrame(animation: Animation) {
  animation.pause();
  requestAnimationFrame(() => {
    if (animation.playState === "paused") animation.play();
  });
}

function cancelAnimations(element: Element, id: string) {
  for (const animation of element.getAnimations()) {
    if (animation.id === id) animation.cancel();
  }
}

/** Fades a leaving copy out and removes it. */
function fadeOutCopy(copy: HTMLElement, parent: HTMLElement) {
  parent.append(copy);
  const out = copy.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: PANEL_ANIMATION_DURATION,
    easing: PANEL_MOTION_EASING,
  });
  void out.finished.then(
    () => copy.remove(),
    () => copy.remove(),
  );
  playFromNextFrame(out);
}

// An element as it looks now, to fade out where it was over its replacement.
// Its look is frozen inline, since the new layout restyles it.
function frozenCopy(element: HTMLElement) {
  const copy = element.cloneNode(true) as HTMLElement;
  const sources = [element, ...element.querySelectorAll<HTMLElement>("*")];
  const copies = [copy, ...copy.querySelectorAll<HTMLElement>("*")];
  sources.forEach((source, index) => {
    const target = copies[index];
    if (!target) return;
    const computed = getComputedStyle(source);
    for (const property of FROZEN_STYLES) target.style[property] = computed[property];
    target.style.transition = "none";
    // Nothing that finds the live controls may find their copies.
    for (const attribute of COPY_STRIPPED_ATTRIBUTES) target.removeAttribute(attribute);
  });
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  return copy;
}

/**
 * The draft hero's heading keeps one look as its pane resizes and its names
 * change, without snaps:
 *
 * - Its type steps with the pane (container queries). A step plays as a scale
 *   from the old size to the new, anchored at the bottom centre where the
 *   heading meets the composer, and ends on the real font size with no
 *   transform, so the text settles crisp.
 * - A chat's " · in <project>" tail stays on the greeting's line while both
 *   fit, and otherwise moves to a smaller line of its own (`data-stacked`).
 *   The greeting glides to its new place while the tail crossfades.
 * - Work's "<project> / <repository>?" (WorkHeroSentence) is laid out in
 *   pieces. When a name changes, or the breadcrumb wraps under its lead or
 *   back, every piece glides from where it was drawn to its new place, and a
 *   changed name crossfades: the old one fades out where it stood. A heading
 *   that replaces another (`handoff`, the FadeSwap group it shares) picks up
 *   from the one it replaced instead of crossfading the whole sentence.
 *
 * Layout is read in a resize observer and on `contentKey` changes, after
 * layout and before paint, so no frame shows the wrong size or layout.
 * Reduced motion keeps opacity only. `rebindKey` changes when the heading's
 * tail mounts or unmounts.
 */
export function useHeroHeadlineMotion(
  headingRef: RefObject<HTMLElement | null>,
  measureRef: RefObject<HTMLElement | null>,
  rebindKey: string,
  options: { readonly contentKey?: string; readonly handoff?: string } = {},
) {
  const { contentKey = "", handoff: handoffGroup } = options;
  const updateRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const heading = headingRef.current;
    const measure = measureRef.current;
    if (!heading || !measure) return;
    let disposed = false;
    let fontSize = Number.parseFloat(getComputedStyle(heading).fontSize);
    let greetingOffset: Offset | null = null;
    const reduced = () => window.matchMedia(REDUCED_MOTION).matches;
    const timing = { duration: PANEL_ANIMATION_DURATION, easing: PANEL_MOTION_EASING };

    let pieces: Pieces | null = null;
    let piecesFromHandoff = false;
    if (handoffGroup !== undefined && handoff?.group === handoffGroup) {
      pieces = handoff.pieces;
      piecesFromHandoff = true;
      handoff = null;
    }

    const livePieces = () => [...heading.querySelectorAll<HTMLElement>(PIECE_SELECTOR)];

    const snapshotPieces = (elements: readonly HTMLElement[]): Pieces => {
      const scale = drawnScale(heading);
      const frame = heading.getBoundingClientRect();
      const next = new Map<string, PieceSnapshot>();
      for (const element of elements) {
        const name = element.dataset.heroPiece;
        if (!name) continue;
        const shift = pieceShift(element, scale);
        const box = element.getBoundingClientRect();
        let copy: HTMLElement | null = null;
        if (SWAPPING_PIECES.has(name)) {
          copy = frozenCopy(element);
          const computed = getComputedStyle(element);
          Object.assign(copy.style, {
            position: "fixed",
            margin: "0",
            pointerEvents: "none",
            opacity: "1",
            transform: "none",
            font: computed.font,
            whiteSpace: "nowrap",
          });
        }
        next.set(name, {
          // From the bottom: the heading sits on the composer and grows upward.
          left: box.left - shift.x - frame.left,
          top: box.top - shift.y - frame.bottom,
          width: box.width,
          key: pieceKey(element),
          copy,
        });
      }
      return next;
    };

    const stepFont = () => {
      const next = Number.parseFloat(getComputedStyle(heading).fontSize);
      if (!Number.isFinite(next) || next === fontSize) return;
      // Picks up from whatever size an interrupted step had reached.
      const from = (drawnScale(heading) * fontSize) / next;
      fontSize = next;
      cancelAnimations(heading, STEP_ANIMATION_ID);
      const animation = reduced()
        ? heading.animate([{ opacity: 0 }, { opacity: 1 }], timing)
        : heading.animate([{ transform: `scale(${from})` }, { transform: "none" }], timing);
      animation.id = STEP_ANIMATION_ID;
      playFromNextFrame(animation);
      // Pieces are measured at rest; a scaled heading would misplace them.
      void animation.finished.then(
        () => {
          if (disposed) return;
          const elements = livePieces();
          pieces = elements.length > 0 ? snapshotPieces(elements) : null;
        },
        () => undefined,
      );
    };

    const stepping = () =>
      heading
        .getAnimations()
        .some(
          (animation) => animation.id === STEP_ANIMATION_ID && animation.playState !== "finished",
        );

    const crossfadeSuffix = (suffix: HTMLElement) => {
      const copy = frozenCopy(suffix);
      const box = suffix.getBoundingClientRect();
      const frame = heading.getBoundingClientRect();
      const scale = drawnScale(heading);
      Object.assign(copy.style, {
        position: "absolute",
        left: `${(box.left - frame.left) / scale}px`,
        top: `${(box.top - frame.top) / scale}px`,
        margin: "0",
        pointerEvents: "none",
      });
      return copy;
    };

    /** Fades the leaving tail out and the new one in, and glides the lead from where it was. */
    const restack = (
      lead: HTMLElement,
      tail: HTMLElement,
      leaving: HTMLElement,
      before: Offset,
    ) => {
      const after = offsetWithin(lead, heading);
      cancelAnimations(lead, STACK_ANIMATION_ID);
      cancelAnimations(tail, STACK_ANIMATION_ID);
      fadeOutCopy(leaving, heading);
      const into = tail.animate([{ opacity: 0 }, { opacity: 1 }], timing);
      into.id = STACK_ANIMATION_ID;
      playFromNextFrame(into);
      // Glides from where it was, but never from outside the heading: after a
      // big resize the old place may be past the pane's edge.
      const scale = drawnScale(heading);
      const box = lead.getBoundingClientRect();
      const frame = heading.getBoundingClientRect();
      const low = frame.left - box.left;
      const high = frame.right - box.right;
      const shift = low <= high ? Math.min(Math.max(before.x - after.x, low), high) : 0;
      const dx = shift / scale;
      const dy = (before.y - after.y) / scale;
      if (reduced() || (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5)) return;
      const glide = lead.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        timing,
      );
      glide.id = STACK_ANIMATION_ID;
      playFromNextFrame(glide);
    };

    /**
     * Glides each Work piece from where it was drawn to where it now sits, and
     * crossfades a piece whose content changed.
     */
    const animatePieces = (before: Pieces, elements: readonly HTMLElement[]) => {
      const scale = drawnScale(heading);
      const frame = heading.getBoundingClientRect();
      const glide = !reduced();
      for (const element of elements) {
        const name = element.dataset.heroPiece;
        const was = name ? before.get(name) : undefined;
        if (!name || !was) continue;
        // A glide still running keeps its offset through the change, so the
        // piece starts from where it is drawn, not where it was laid out.
        const shift = pieceShift(element, scale);
        const box = element.getBoundingClientRect();
        const fromLeft = frame.left + was.left + shift.x;
        const fromTop = frame.bottom + was.top + shift.y;
        const dx = (fromLeft - (box.left - shift.x)) / scale;
        const dy = (fromTop - (box.top - shift.y)) / scale;
        const travels = glide && (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5);
        const changed = was.key !== pieceKey(element);
        if (!travels && !changed) continue;
        cancelAnimations(element, PIECE_ANIMATION_ID);
        if (changed && was.copy) {
          Object.assign(was.copy.style, {
            left: `${fromLeft}px`,
            top: `${fromTop}px`,
            width: `${was.width}px`,
          });
          fadeOutCopy(was.copy, document.body);
        }
        const from: Keyframe = {};
        const to: Keyframe = {};
        if (travels) {
          from.transform = `translate(${dx}px, ${dy}px)`;
          to.transform = "none";
        }
        if (changed) {
          from.opacity = 0;
          to.opacity = 1;
        }
        const animation = element.animate([from, to], timing);
        animation.id = PIECE_ANIMATION_ID;
        playFromNextFrame(animation);
      }
    };

    const placePieces = () => {
      const elements = livePieces();
      if (elements.length === 0) {
        pieces = null;
        return;
      }
      if (stepping()) {
        // Measured again once the step lands.
        pieces = null;
        return;
      }
      const before = pieces;
      if (before !== null) {
        animatePieces(before, elements);
        // This heading took over from the one it replaced: its pieces carry the
        // change, so the whole sentence does not crossfade as well.
        if (piecesFromHandoff && handoffGroup !== undefined) settleFadeSwap(handoffGroup);
        piecesFromHandoff = false;
      }
      // Copies are taken fresh each time, so one already used is never reused.
      pieces = snapshotPieces(elements);
    };

    const placeSuffix = () => {
      const greeting = heading.querySelector<HTMLElement>(GREETING_SELECTOR);
      const crumb = heading.querySelector<HTMLElement>(BREADCRUMB_SELECTOR);
      if (greeting && crumb) {
        heading.removeAttribute(STACKED_ATTRIBUTE);
        greetingOffset = null;
        placePieces();
        return;
      }
      pieces = null;
      const suffix = heading.querySelector<HTMLElement>(SUFFIX_SELECTOR);
      if (!greeting || !suffix) {
        heading.removeAttribute(STACKED_ATTRIBUTE);
        greetingOffset = null;
        return;
      }
      // One line holds the greeting and its tail at the heading's own size.
      const suffixText = suffix.querySelector(SUFFIX_TEXT_SELECTOR);
      const line = `${greeting.textContent ?? ""}${suffixText?.textContent ?? ""}`;
      if (measure.textContent !== line) measure.textContent = line;
      // The tail's folder icon is not text: its width and gap (HERO_INLINE_ICON_STYLE).
      measure.style.paddingInlineEnd = suffixText?.querySelector("svg") ? "1.06em" : "";
      const hasTail = (suffix.querySelector(SUFFIX_TEXT_SELECTOR)?.textContent ?? "") !== "";
      const stacked = hasTail && measure.offsetWidth > heading.clientWidth;
      const wasStacked = heading.hasAttribute(STACKED_ATTRIBUTE);
      if (stacked === wasStacked) {
        greetingOffset = offsetWithin(greeting, heading);
        return;
      }
      const leaving = greetingOffset === null ? null : crossfadeSuffix(suffix);
      heading.toggleAttribute(STACKED_ATTRIBUTE, stacked);
      const before = greetingOffset;
      greetingOffset = offsetWithin(greeting, heading);
      // The first layout of a screen just paints.
      if (before === null || leaving === null) return;
      restack(greeting, suffix, leaving, before);
    };

    const update = () => {
      stepFont();
      placeSuffix();
    };
    updateRef.current = update;
    // Settled before the first paint; later changes arrive after layout, before paint.
    update();
    const suffix = heading.querySelector<HTMLElement>(SUFFIX_SELECTOR);
    const crumb = heading.querySelector<HTMLElement>(BREADCRUMB_SELECTOR);
    const observed = [heading, suffix, crumb].filter(
      (element): element is HTMLElement => element !== null,
    );
    const stopObserving = observeResize(observed, update);
    // A late web font changes the line's width without resizing the heading.
    document.fonts.addEventListener("loadingdone", update);
    return () => {
      disposed = true;
      updateRef.current = null;
      stopObserving();
      document.fonts.removeEventListener("loadingdone", update);
      if (handoffGroup !== undefined && pieces !== null) {
        const entry = { group: handoffGroup, pieces };
        handoff = entry;
        setTimeout(() => {
          if (handoff === entry) handoff = null;
        }, 0);
      }
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new tail is a new element to observe.
  }, [headingRef, measureRef, rebindKey, handoffGroup]);
  // A picked name lands in the same commit; measured before it paints.
  useLayoutEffect(() => {
    updateRef.current?.();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Runs when the shown names change.
  }, [contentKey]);
}

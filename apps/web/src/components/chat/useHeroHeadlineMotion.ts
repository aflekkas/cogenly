import { useLayoutEffect, type RefObject } from "react";

import { PANEL_ANIMATION_DURATION } from "~/panelAnimations";
import { observeResize } from "~/lib/observeResize";
import { PANEL_MOTION_EASING } from "~/lib/panelFlip";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const STEP_ANIMATION_ID = "hero-headline-step";
const STACK_ANIMATION_ID = "hero-headline-stack";
/** The heading's own line, and the chat project tail that may follow it. */
const GREETING_SELECTOR = "[data-hero-greeting]";
const SUFFIX_SELECTOR = "[data-hero-project-suffix]";
const SUFFIX_TEXT_SELECTOR = "[data-hero-suffix-shown]";
/** Work's "<project> / <repository>?", which follows the lead or wraps whole under it. */
const BREADCRUMB_SELECTOR = "[data-hero-breadcrumb]";
/** Set on the heading while the project tail sits on a line of its own. */
const STACKED_ATTRIBUTE = "data-stacked";
/** Markers and ids a tail's leaving copy must not repeat. */
const COPY_STRIPPED_ATTRIBUTES = [
  "id",
  "data-hero-project-suffix",
  "data-hero-suffix-shown",
  "data-hero-breadcrumb",
  "data-hero-project-picker",
  "data-draft-project-trigger",
] as const;
/** What the tail's leaving copy keeps of its old look. */
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

interface BreadcrumbPlace {
  /** Its left edge from the heading's centre. */
  readonly x: number;
  readonly bottom: number;
  readonly width: number;
}

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

/**
 * The draft hero's heading keeps one look as its pane resizes, without snaps:
 *
 * - Its type steps with the pane (container queries). A step plays as a scale
 *   from the old size to the new, anchored at the bottom centre where the
 *   heading meets the composer, and ends on the real font size with no
 *   transform, so the text settles crisp.
 * - A chat's " · in <project>" tail stays on the greeting's line while both
 *   fit, and otherwise moves to a smaller line of its own (`data-stacked`).
 *   The greeting glides to its new place while the tail crossfades.
 * - Work's "<project> / <repository>?" breadcrumb wraps under its lead on its
 *   own when the line is too narrow (WorkHeroSentence); the same glide and
 *   crossfade play when it does.
 *
 * Both are read in a resize observer, after layout and before paint, so no
 * frame shows the wrong size or layout. Reduced motion keeps opacity only.
 * `rebindKey` changes when the heading's tail mounts or unmounts.
 */
export function useHeroHeadlineMotion(
  headingRef: RefObject<HTMLElement | null>,
  measureRef: RefObject<HTMLElement | null>,
  rebindKey: string,
) {
  useLayoutEffect(() => {
    const heading = headingRef.current;
    const measure = measureRef.current;
    if (!heading || !measure) return;
    let fontSize = Number.parseFloat(getComputedStyle(heading).fontSize);
    let greetingOffset: Offset | null = null;
    const reduced = () => window.matchMedia(REDUCED_MOTION).matches;

    const stepFont = () => {
      const next = Number.parseFloat(getComputedStyle(heading).fontSize);
      if (!Number.isFinite(next) || next === fontSize) return;
      // Picks up from whatever size an interrupted step had reached.
      const from = (drawnScale(heading) * fontSize) / next;
      fontSize = next;
      cancelAnimations(heading, STEP_ANIMATION_ID);
      const animation = reduced()
        ? heading.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: PANEL_ANIMATION_DURATION,
            easing: PANEL_MOTION_EASING,
          })
        : heading.animate([{ transform: `scale(${from})` }, { transform: "none" }], {
            duration: PANEL_ANIMATION_DURATION,
            easing: PANEL_MOTION_EASING,
          });
      animation.id = STEP_ANIMATION_ID;
      playFromNextFrame(animation);
    };

    // A tail as it looks now, to fade out where it was over the one fading in.
    // Its look is frozen inline, since the heading's new layout restyles it.
    const frozenCopy = (tail: HTMLElement) => {
      const copy = tail.cloneNode(true) as HTMLElement;
      const sources = [tail, ...tail.querySelectorAll<HTMLElement>("*")];
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
    };

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
      const timing = { duration: PANEL_ANIMATION_DURATION, easing: PANEL_MOTION_EASING };
      heading.append(leaving);
      const out = leaving.animate([{ opacity: 1 }, { opacity: 0 }], timing);
      void out.finished.then(
        () => leaving.remove(),
        () => leaving.remove(),
      );
      playFromNextFrame(out);
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

    /** Where the Work breadcrumb sits, from the heading's bottom centre, unscaled. */
    const breadcrumbPlace = (crumb: HTMLElement): BreadcrumbPlace => {
      const box = crumb.getBoundingClientRect();
      const frame = heading.getBoundingClientRect();
      const scale = drawnScale(heading);
      return {
        x: (box.left - (frame.left + frame.right) / 2) / scale,
        bottom: (frame.bottom - box.bottom) / scale,
        width: box.width / scale,
      };
    };

    // The Work sentence wraps on its own (WorkHeroSentence keeps its
    // breadcrumb whole), so the move is seen after layout: the leaving copy
    // goes where the breadcrumb was a frame ago.
    let breadcrumb: {
      readonly lead: HTMLElement;
      readonly wrapped: boolean;
      readonly leadOffset: Offset;
      readonly place: BreadcrumbPlace;
    } | null = null;
    const placeBreadcrumb = (lead: HTMLElement, crumb: HTMLElement) => {
      const leadBox = lead.getBoundingClientRect();
      const crumbBox = crumb.getBoundingClientRect();
      const wrapped = crumbBox.top > leadBox.bottom - crumbBox.height / 2;
      const before = breadcrumb;
      breadcrumb = {
        lead,
        wrapped,
        leadOffset: offsetWithin(lead, heading),
        place: breadcrumbPlace(crumb),
      };
      // A new sentence (its own cross-fade) or the first layout just paints.
      if (before === null || before.lead !== lead || before.wrapped === wrapped) return;
      const leaving = frozenCopy(crumb);
      Object.assign(leaving.style, {
        position: "absolute",
        left: `${heading.clientWidth / 2 + before.place.x}px`,
        bottom: `${before.place.bottom}px`,
        width: `${before.place.width}px`,
        margin: "0",
        pointerEvents: "none",
      });
      restack(lead, crumb, leaving, before.leadOffset);
    };

    const placeSuffix = () => {
      const greeting = heading.querySelector<HTMLElement>(GREETING_SELECTOR);
      const crumb = heading.querySelector<HTMLElement>(BREADCRUMB_SELECTOR);
      if (greeting && crumb) {
        heading.removeAttribute(STACKED_ATTRIBUTE);
        greetingOffset = null;
        placeBreadcrumb(greeting, crumb);
        return;
      }
      breadcrumb = null;
      const suffix = heading.querySelector<HTMLElement>(SUFFIX_SELECTOR);
      if (!greeting || !suffix) {
        heading.removeAttribute(STACKED_ATTRIBUTE);
        greetingOffset = null;
        return;
      }
      // One line holds the greeting and its tail at the heading's own size.
      const line = `${greeting.textContent ?? ""}${
        suffix.querySelector(SUFFIX_TEXT_SELECTOR)?.textContent ?? ""
      }`;
      if (measure.textContent !== line) measure.textContent = line;
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
    // Settled before the first paint; later changes arrive after layout, before paint.
    update();
    const suffix = heading.querySelector(SUFFIX_SELECTOR);
    const stopObserving = observeResize(suffix ? [heading, suffix] : heading, update);
    // A late web font changes the line's width without resizing the heading.
    document.fonts.addEventListener("loadingdone", update);
    return () => {
      stopObserving();
      document.fonts.removeEventListener("loadingdone", update);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new tail is a new element to observe.
  }, [headingRef, measureRef, rebindKey]);
}

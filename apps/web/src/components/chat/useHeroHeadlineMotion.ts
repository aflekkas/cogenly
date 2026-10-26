import { useLayoutEffect, type RefObject } from "react";

import { observeResize } from "~/lib/observeResize";
import { LAYOUT_MOTION_DURATION } from "~/panelAnimations";

import { HERO_HEADING_GROUP } from "./HeroHeadline";
import { settleFadeSwap } from "./StateTransition";

interface HeadlineSnapshot {
  readonly key: string;
  readonly copy: HTMLElement;
}

// A project pick can replace the draft in the same commit. Carry its last
// sentence across that remount, rather than playing a second entrance fade.
interface LeavingFade {
  readonly copy: HTMLElement;
  readonly animation: Animation;
}

interface LeavingHeadline {
  readonly snapshot: HeadlineSnapshot;
  readonly incoming: Animation | undefined;
  readonly outgoing: Set<LeavingFade>;
}
const leaving = new Map<string, LeavingHeadline>();
const ANIMATION_ID = "hero-headline-content";

function contentKey(heading: HTMLElement) {
  return `${heading.textContent}|${[...heading.querySelectorAll("img")].map((img) => img.src).join("|")}`;
}

function snapshot(heading: HTMLElement): HeadlineSnapshot {
  const copy = heading.cloneNode(true) as HTMLElement;
  const box = heading.getBoundingClientRect();
  const computed = getComputedStyle(heading);
  Object.assign(copy.style, {
    position: "fixed",
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    margin: "0",
    font: computed.font,
    letterSpacing: computed.letterSpacing,
    color: computed.color,
    pointerEvents: "none",
    transition: "none",
  });
  // Container queries must keep their resolved type after leaving the hero.
  for (const element of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) {
    element.removeAttribute("id");
    for (const name of element.getAttributeNames()) {
      if (name.startsWith("data-")) element.removeAttribute(name);
    }
  }
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  return { key: contentKey(heading), copy };
}

/**
 * One opacity crossfade owns greeting, project and repository changes, including
 * draft replacement. Names take their natural width, so a new one may reflow
 * the sentence: the old sentence fades out where it stood while the new one
 * fades in already laid out, so nothing glides or snaps. Resize only refreshes
 * the leaving copy; it does not replay content animation or feed measurements
 * back into layout.
 */
export function useHeroHeadlineMotion(headingRef: RefObject<HTMLElement | null>, group: string) {
  useLayoutEffect(() => {
    const heading = headingRef.current;
    if (!heading) return;
    const previous = leaving.get(group);
    leaving.delete(group);
    let before = previous?.snapshot;
    let incoming = previous?.incoming;
    const outgoing = previous?.outgoing ?? new Set<LeavingFade>();
    // Retarget a running fade across draft replacement without restarting it.
    if (incoming?.effect instanceof KeyframeEffect) incoming.effect.target = heading;

    const update = () => {
      const nextKey = contentKey(heading);
      if (before && before.key !== nextKey) {
        const drawnOpacity = Number.parseFloat(getComputedStyle(heading).opacity);
        incoming?.cancel();
        const copy = before.copy;
        document.body.append(copy);
        const timing = {
          duration: LAYOUT_MOTION_DURATION,
          easing:
            getComputedStyle(document.documentElement)
              .getPropertyValue("--motion-ease-standard")
              .trim() || "ease-out",
        };
        // Interrupted changes keep already-leaving text fading, and the latest
        // sentence leaves at its drawn opacity instead of popping to full strength.
        const animation = copy.animate(
          [{ opacity: Number.isFinite(drawnOpacity) ? drawnOpacity : 1 }, { opacity: 0 }],
          timing,
        );
        const fade = { copy, animation };
        outgoing.add(fade);
        incoming = heading.animate([{ opacity: 0 }, { opacity: 1 }], timing);
        incoming.id = ANIMATION_ID;
        const remove = () => {
          copy.remove();
          outgoing.delete(fade);
        };
        void animation.finished.then(remove, remove);
      }
      // FadeSwap handles changing surfaces; this hook handles one sentence's
      // content, so a replacing draft must not also fade the entire slot.
      if (before) settleFadeSwap(HERO_HEADING_GROUP);
      before = snapshot(heading);
    };
    update();
    const mutations = new MutationObserver(update);
    mutations.observe(heading, { childList: true, characterData: true, subtree: true });
    const stopObserving = observeResize([heading], () => {
      before = snapshot(heading);
    });
    return () => {
      mutations.disconnect();
      stopObserving();
      if (before) {
        const entry = { snapshot: before, incoming, outgoing };
        leaving.set(group, entry);
        setTimeout(() => {
          if (leaving.get(group) !== entry) return;
          leaving.delete(group);
          entry.incoming?.cancel();
          for (const fade of entry.outgoing) {
            fade.animation.cancel();
            fade.copy.remove();
          }
        }, 0);
      }
    };
  }, [headingRef, group]);
}

import { useLayoutEffect, useRef, type RefObject, type TransitionEvent } from "react";

// Matches --motion-duration-base and ease-standard in index.css.
const MOTION = { duration: 220, easing: "cubic-bezier(0.32, 0.72, 0, 1)" };
const FLIP_SELECTOR = "[data-agent-flip]";

type Offsets = Map<string, { top: number; left: number }>;

function measure(root: HTMLElement): Offsets {
  const origin = root.getBoundingClientRect();
  const offsets: Offsets = new Map();
  for (const element of root.querySelectorAll<HTMLElement>(FLIP_SELECTOR)) {
    const rect = element.getBoundingClientRect();
    offsets.set(element.dataset.agentFlip!, {
      top: rect.top - origin.top,
      left: rect.left - origin.left,
    });
  }
  return offsets;
}

/**
 * When an agent moves to another project, its card glides from where it was
 * to its place in the new group, and the cards and headers it displaces glide
 * with it; a header that appears fades in. Only a change of an agent's own
 * project plays, never a first render, a remount, or a list that only
 * re-sorted, so loading never animates. Reduced motion fades the moved card
 * in place instead. Offsets are measured against the list, so scrolling
 * between updates does not skew them.
 *
 * Mark each card and header with a stable `data-agent-flip` key; `folders`
 * maps each agent's flip key to its project folder. Put the returned
 * `onTransitionEnd` on the list.
 */
export function useAgentGroupFlip(
  rootRef: RefObject<HTMLElement | null>,
  folders: ReadonlyMap<string, string | null>,
) {
  const previous = useRef<{ offsets: Offsets; folders: ReadonlyMap<string, string | null> } | null>(
    null,
  );
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      previous.current = null;
      return;
    }
    const next = measure(root);
    const before = previous.current;
    previous.current = { offsets: next, folders };
    if (!before) return;
    const moved = [...folders].filter(([key, folder]) => {
      const was = before.folders.get(key);
      return was !== undefined && was !== folder;
    });
    if (moved.length === 0) return;
    const movedKeys = new Set(moved.map(([key]) => key));
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const element of root.querySelectorAll<HTMLElement>(FLIP_SELECTOR)) {
      if (typeof element.animate !== "function") return;
      const key = element.dataset.agentFlip!;
      const from = before.offsets.get(key);
      const to = next.get(key);
      if (!to) continue;
      if (!from) {
        element.animate([{ opacity: 0 }, { opacity: 1 }], MOTION);
        continue;
      }
      if (reduced) {
        if (movedKeys.has(key)) element.animate([{ opacity: 0 }, { opacity: 1 }], MOTION);
        continue;
      }
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (dx === 0 && dy === 0) continue;
      // The moved card rides above the ones it passes.
      const zIndex = movedKeys.has(key) ? 1 : 0;
      element.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)`, zIndex },
          { transform: "translate(0, 0)", zIndex },
        ],
        MOTION,
      );
    }
  });
  // A group that finishes opening or closing moves what follows it after the
  // commit was measured; the list measures again once it settles.
  const onTransitionEnd = (event: TransitionEvent<HTMLElement>) => {
    const root = rootRef.current;
    if (!root || !previous.current) return;
    if (!(event.target instanceof HTMLElement) || !event.target.matches(".agent-group-collapse"))
      return;
    previous.current = { ...previous.current, offsets: measure(root) };
  };
  return { onTransitionEnd };
}

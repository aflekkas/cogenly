import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef } from "react";

import {
  capturePanelFlip,
  playPanelFlip,
  retargetPanelFlip,
  type PanelFlipSnapshot,
} from "../../lib/panelFlip";
import { usePanelAnimationSettings } from "../../panelAnimations";
import { useRightPanelStore } from "../../rightPanelStore";
import { useListColumnLayoutStore } from "../sidebar/listColumnLayoutStore";

/**
 * Glides the chat's marked content when the inline right panel opens, closes
 * or maximizes. The store notifies synchronously, before React renders the
 * change, so the snapshot holds the old layout; the flip plays once the new
 * layout commits. Contained, like the sidebar's: the chat column keeps its
 * fixed edge while the panel covers or uncovers the other, so it never lays
 * out past the window. Open and close take the same time as the panel's own
 * slide, so the content and the panel settle together.
 *
 * The list column may step aside for the panel (or come back) in a second
 * commit of the same task. The sidebar then starts its own flip from that
 * never-painted in-between layout and at its own exit pace, cancelling this
 * one. This hook keeps the panel's snapshot for the motion's length and,
 * after that commit, re-aims its flip at the final layout: one glide, from
 * where the content was last drawn, on the panel's timeline.
 */
export function useRightPanelFlip(
  root: HTMLElement | null,
  threadRef: ScopedThreadRef | null,
  inline: boolean,
  open: boolean,
  maximized: boolean,
) {
  const { active, durationMs } = usePanelAnimationSettings();
  const snapshotRef = useRef<PanelFlipSnapshot | null>(null);
  const motionRef = useRef<{ snapshot: PanelFlipSnapshot; endsAt: number } | null>(null);
  const listColumnAutoCollapsed = useListColumnLayoutStore((state) => state.autoCollapsed);
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;

  useEffect(() => {
    if (!root || threadKey === null || !inline || !active) return;
    return useRightPanelStore.subscribe((state, previous) => {
      const next = state.byThreadKey[threadKey];
      const before = previous.byThreadKey[threadKey];
      if (
        next?.isOpen !== before?.isOpen ||
        (next?.maximized ?? false) !== (before?.maximized ?? false)
      ) {
        snapshotRef.current = capturePanelFlip(root);
      }
    });
  }, [active, inline, root, threadKey]);

  useLayoutEffect(() => {
    const snapshot = snapshotRef.current;
    snapshotRef.current = null;
    if (!snapshot) return;
    motionRef.current = { snapshot, endsAt: performance.now() + durationMs };
    playPanelFlip(snapshot, durationMs, { contain: true });
  }, [durationMs, open, maximized]);

  // Runs after the sidebar's own layout effect in the commit that collapsed
  // or restored the list column, and before that commit paints (a discrete
  // event's effects flush synchronously), so the one glide the user sees is
  // this one.
  useEffect(() => {
    const motion = motionRef.current;
    if (!motion) return;
    if (performance.now() >= motion.endsAt) {
      motionRef.current = null;
      return;
    }
    retargetPanelFlip(motion.snapshot, durationMs, { contain: true });
  }, [durationMs, listColumnAutoCollapsed]);
}

import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef } from "react";

import {
  capturePanelFlip,
  PANEL_MOTION_SETTLE_MS,
  playPanelFlip,
  retargetPanelFlip,
  type PanelFlipSnapshot,
} from "../../lib/panelFlip";
import { PANEL_ANIMATION_DURATION, readPanelAnimationsActive } from "../../panelAnimations";
import { useRightPanelStore } from "../../rightPanelStore";
import { useListColumnLayoutStore } from "../sidebar/listColumnLayoutStore";

/**
 * Glides the chat's marked content and the panel itself when the inline right
 * panel opens, closes or maximizes. The store notifies synchronously, before
 * React renders the change, so the snapshot holds the old layout; the flip
 * plays once the new layout commits. Contained, like the sidebar's: the chat
 * column reflows once and keeps its left edge while the panel covers or
 * uncovers it. The panel is marked too (PreviewPanelShell), so it slides in
 * the same flip, on the same duration and curve as the content.
 *
 * The list column may step aside for the panel (or come back) in a second
 * commit of the same task. The sidebar then starts its own flip from that
 * never-painted in-between layout, cancelling this one. This hook keeps the
 * panel's snapshot for the motion's length and, after that commit, re-aims
 * its flip at the final layout: one glide, from where the content was last
 * drawn.
 */
export function useRightPanelFlip(
  root: HTMLElement | null,
  threadRef: ScopedThreadRef | null,
  inline: boolean,
  open: boolean,
  maximized: boolean,
) {
  const durationMs = PANEL_ANIMATION_DURATION;
  const snapshotRef = useRef<PanelFlipSnapshot | null>(null);
  const motionRef = useRef<{ snapshot: PanelFlipSnapshot; endsAt: number } | null>(null);
  const listColumnAutoCollapsed = useListColumnLayoutStore((state) => state.autoCollapsed);
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;

  useEffect(() => {
    if (!root || threadKey === null || !inline) return;
    return useRightPanelStore.subscribe((state, previous) => {
      // Read as the change happens: reduced motion, or a navigation's first
      // frame, snaps the panel instead.
      if (!readPanelAnimationsActive()) return;
      const next = state.byThreadKey[threadKey];
      const before = previous.byThreadKey[threadKey];
      if (
        next?.isOpen !== before?.isOpen ||
        (next?.maximized ?? false) !== (before?.maximized ?? false)
      ) {
        snapshotRef.current = capturePanelFlip(root);
      }
    });
  }, [inline, root, threadKey]);

  useLayoutEffect(() => {
    const snapshot = snapshotRef.current;
    snapshotRef.current = null;
    if (!snapshot) return;
    motionRef.current = {
      snapshot,
      endsAt: performance.now() + durationMs + PANEL_MOTION_SETTLE_MS,
    };
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

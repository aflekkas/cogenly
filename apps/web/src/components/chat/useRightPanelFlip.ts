import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef } from "react";

import { capturePanelFlip, playPanelFlip, type PanelFlipSnapshot } from "../../lib/panelFlip";
import { usePanelAnimationSettings } from "../../panelAnimations";
import { useRightPanelStore } from "../../rightPanelStore";

/**
 * Glides the chat's marked content when the inline right panel opens or
 * closes. The store notifies synchronously, before React renders the change,
 * so the snapshot holds the old layout; the flip plays once `open` commits.
 */
export function useRightPanelFlip(
  root: HTMLElement | null,
  threadRef: ScopedThreadRef | null,
  inline: boolean,
  open: boolean,
) {
  const { active, durationMs } = usePanelAnimationSettings();
  const snapshotRef = useRef<PanelFlipSnapshot | null>(null);
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;

  useEffect(() => {
    if (!root || threadKey === null || !inline || !active) return;
    return useRightPanelStore.subscribe((state, previous) => {
      const isOpen = state.byThreadKey[threadKey]?.isOpen === true;
      if (isOpen !== (previous.byThreadKey[threadKey]?.isOpen === true)) {
        snapshotRef.current = capturePanelFlip(root);
      }
    });
  }, [active, inline, root, threadKey]);

  useLayoutEffect(() => {
    const snapshot = snapshotRef.current;
    snapshotRef.current = null;
    if (snapshot) playPanelFlip(snapshot, durationMs);
  }, [durationMs, open]);
}

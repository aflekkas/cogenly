import { useLayoutEffect, useState } from "react";
import { observeResize } from "~/lib/observeResize";
import { readPanelFlipShift } from "~/lib/panelFlip";
import { useChatCanvas } from "./ChatCanvasContext";
import { resolveTimelineMinimapClearance } from "./timelineMinimapClearance.logic";

/** Measures the resting rail, never the animated rail, so motion needs no JS per frame. */
export function useTimelineMinimapClearance(interactive: boolean) {
  const canvas = useChatCanvas();
  const detailsCard = canvas?.detailsCard ?? null;
  const [element, ref] = useState<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState({ top: 0, height: 0, animate: false });
  useLayoutEffect(() => {
    if (!element) return;
    const root = element.closest<HTMLElement>("[data-chat-canvas]");
    const viewport = element.closest<HTMLElement>(
      "[data-testid='timeline-minimap']",
    )?.parentElement;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const origin = root?.getBoundingClientRect();
      const glide = readPanelFlipShift(element) - (root ? readPanelFlipShift(root) : 0);
      const next = resolveTimelineMinimapClearance({
        rail: {
          left: rect.right - glide - (origin?.left ?? 0) - 24,
          right: rect.right - glide - (origin?.left ?? 0),
          top: rect.top - (origin?.top ?? 0),
          height: rect.height,
        },
        viewportBottom:
          (viewport?.getBoundingClientRect().bottom ?? rect.bottom) - (origin?.top ?? 0),
        detailsCard: interactive ? detailsCard : null,
      });
      setGeometry((current) =>
        current.top === next.top && current.height === next.height
          ? current
          : {
              ...next,
              // History mounts and ordinary resizes keep their existing placement behavior.
              animate: current.height > 0 && (current.top > 0 || next.top > 0),
            },
      );
    };
    measure();
    return observeResize(
      [element, ...(root ? [root] : []), ...(viewport ? [viewport] : [])],
      measure,
    );
  }, [element, detailsCard, interactive]);
  return { ref, ...geometry };
}

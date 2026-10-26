"use client";

import * as React from "react";

import { observeResize } from "~/lib/observeResize";
import { nextPanelHeight, type PanelHeight } from "./animatedPanelHeight.logic";

export interface AnimatedPanelHeight {
  /** Spread on the panel: the element whose height animates. Pair it with `panel-height-motion`. */
  readonly panelProps: {
    readonly "data-panel-height"?: "animate" | "measured";
    readonly style?: React.CSSProperties;
  };
  /** Callback ref for the wrapper that lays the content out at its natural, clamped height. */
  readonly contentRef: (element: HTMLElement | null) => void;
}

const DISABLED: AnimatedPanelHeight = { panelProps: {}, contentRef: () => {} };

/**
 * Glides a floating panel (popover, menu, palette, composer drawer) to its content's new height
 * when results arrive, a filter narrows or a submenu swaps its rows.
 *
 * ```tsx
 * const panel = useAnimatedPanelHeight();
 * <div className="panel-height-motion" {...panel.panelProps}>
 *   <div ref={panel.contentRef} className="max-h-72 overflow-y-auto">…</div>
 * </div>
 * ```
 *
 * The content wrapper keeps its own max-height and scrolling, so the panel animates up to the
 * clamp and the content still scrolls past it. Its height must not depend on the panel's: no
 * `h-full`, and `shrink-0` when the panel is a flex column. Padding belongs on the content, since
 * the panel's height is the content's border box. The panel clips while it animates and must not
 * carry other transitions (`panel-height-motion` sets `transition-property`), so give it its own
 * element inside a popup that fades and scales.
 *
 * The first size after mount (or after a hidden keepMounted popup reopens) applies at once; only
 * later changes animate, and only while one is in flight. Under reduced motion the size snaps.
 * A panel anchored at its bottom (positioned with `bottom`, or a popup on `side="top"`) grows
 * upward with its bottom edge still.
 *
 * A `holdKey` keeps the panel from shrinking while the key stays the same, for a results list
 * whose edge should not bob as each keystroke narrows it; a new key settles it on the content's
 * height. Make the panel a `flex flex-col justify-end` column to keep the rows on the anchored
 * edge, with the spare height on the far side.
 */
export function useAnimatedPanelHeight(
  enabled = true,
  options?: { readonly holdKey?: string },
): AnimatedPanelHeight {
  const [content, setContent] = React.useState<HTMLElement | null>(null);
  const [size, setSize] = React.useState<PanelHeight | null>(null);
  const active = enabled && content !== null;
  const holdKey = options?.holdKey;
  const holdRef = React.useRef(holdKey !== undefined);
  const measuredRef = React.useRef(0);

  React.useLayoutEffect(() => {
    if (!active || !content) return;
    const stop = observeResize(content, (entries) => {
      const entry = entries.at(-1);
      if (!entry) return;
      const measured = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
      measuredRef.current = measured;
      setSize((previous) => nextPanelHeight(previous, measured, { hold: holdRef.current }));
    });
    return () => {
      stop();
      measuredRef.current = 0;
      setSize(null);
    };
  }, [active, content]);

  React.useLayoutEffect(() => {
    holdRef.current = holdKey !== undefined;
    // The content did not resize, so no observer entry comes: settle on its last height.
    const measured = measuredRef.current;
    if (measured > 0) setSize((previous) => nextPanelHeight(previous, measured));
  }, [holdKey]);

  return React.useMemo(() => {
    if (!enabled) return DISABLED;
    return {
      panelProps: size
        ? {
            "data-panel-height": size.animate ? "animate" : "measured",
            style: { height: size.height, overflow: "clip" },
          }
        : {},
      contentRef: setContent,
    };
  }, [enabled, size]);
}

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
 */
export function useAnimatedPanelHeight(enabled = true): AnimatedPanelHeight {
  const [content, setContent] = React.useState<HTMLElement | null>(null);
  const [size, setSize] = React.useState<PanelHeight | null>(null);
  const active = enabled && content !== null;

  React.useLayoutEffect(() => {
    if (!active || !content) return;
    const stop = observeResize(content, (entries) => {
      const entry = entries.at(-1);
      if (!entry) return;
      const measured = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
      setSize((previous) => nextPanelHeight(previous, measured));
    });
    return () => {
      stop();
      setSize(null);
    };
  }, [active, content]);

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

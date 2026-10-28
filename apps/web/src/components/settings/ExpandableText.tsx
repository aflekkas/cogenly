import { InlineButton } from "../ui/button";
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { canAnimate, prefersReducedMotion, settingsMotionTiming } from "./settingsMotion";
import { clampedPreviewText } from "./settingsText.logic";

type ExpandPhase = "collapsed" | "opening" | "open" | "closing";

/**
 * Long error text clamped to a few lines with a toggle to reveal the rest.
 * Short single-line text renders as-is without the toggle. Toggling grows or
 * shrinks the height between the clamp and the full text (base token, both
 * ways), like a long message's "Show full message" in the timeline; the clamp
 * comes back only once the text has closed. Reduced motion swaps at once and
 * fades the text in. A pretty-printed JSON payload's opening brackets share
 * its first line, clamped or open, so the preview shows content.
 */
export function ExpandableText({
  text,
  className,
  collapsedClassName = "line-clamp-3",
  expandLabel = "Show full error",
}: {
  text: string;
  className?: string;
  collapsedClassName?: string;
  expandLabel?: string;
}) {
  const textId = useId();
  const [phase, setPhase] = useState<ExpandPhase>("collapsed");
  const textRef = useRef<HTMLDivElement>(null);
  // Where the height motion starts; null swaps at once with a fade instead.
  const motionStartHeightRef = useRef<number | null>(null);
  const canExpand = text.length > 180 || text.includes("\n");
  const expanded = phase === "opening" || phase === "open";

  const settle = useCallback(() => {
    setPhase((current) =>
      current === "opening" ? "open" : current === "closing" ? "collapsed" : current,
    );
  }, []);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element || (phase !== "opening" && phase !== "closing")) return;
    const from = motionStartHeightRef.current;
    if (from === null || !canAnimate(element)) {
      if (from === null && canAnimate(element)) {
        element.animate([{ opacity: 0 }, { opacity: 1 }], settingsMotionTiming("fast"));
      }
      settle();
      return;
    }
    // The text stays unclamped while it closes, so measure the clamp's height.
    const clampClasses = collapsedClassName.split(/\s+/).filter(Boolean);
    let to = element.scrollHeight;
    if (phase === "closing") {
      element.classList.add(...clampClasses);
      to = element.getBoundingClientRect().height;
      element.classList.remove(...clampClasses);
    }
    const timing = settingsMotionTiming("base");
    element.style.overflow = "hidden";
    const motion = element.animate([{ height: `${from}px` }, { height: `${to}px` }], timing);
    motion.finished.then(settle, () => {});
    // A motion that never finishes (detached, hidden) still settles.
    const timer = setTimeout(settle, timing.duration + 100);
    return () => {
      clearTimeout(timer);
      motion.cancel();
      element.style.overflow = "";
    };
  }, [phase, collapsedClassName, settle]);

  const toggle = () => {
    const element = textRef.current;
    motionStartHeightRef.current =
      element && !prefersReducedMotion() ? element.getBoundingClientRect().height : null;
    setPhase(expanded ? "closing" : "opening");
  };

  return (
    <div className={cn("min-w-0", className)}>
      <div
        ref={textRef}
        id={textId}
        className={cn(
          "whitespace-pre-wrap break-words",
          canExpand && phase === "collapsed" ? collapsedClassName : null,
        )}
      >
        {/* One string in both states, so only the clamp changes and lines only grow below. */}
        {canExpand ? clampedPreviewText(text) : text}
      </div>
      {canExpand ? (
        <InlineButton
          aria-expanded={expanded}
          aria-controls={textId}
          tone="muted"
          weight="normal"
          className="mt-1"
          onClick={toggle}
        >
          {expanded ? "Show less" : expandLabel}
        </InlineButton>
      ) : null}
    </div>
  );
}

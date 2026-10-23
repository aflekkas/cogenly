import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "../lib/utils";
import { PANEL_MOTION_EASING } from "../lib/panelFlip";
import { PANEL_ANIMATION_DURATION } from "../panelAnimations";
import { HERO_INLINE_ICON_STYLE, ProjectFolderIcon } from "./ProjectFolderMark";

interface Layer {
  readonly key: number;
  readonly name: string | null;
  readonly color: string | undefined;
}

/**
 * The chat hero's " · in <project>" tail. Its width glides to fit the new
 * name, so the centred greeting slides over rather than jumping, while the
 * old and new names crossfade in place: opacity only, nothing rises or
 * slides. The width is free at rest, so it follows the heading's type as it
 * steps with the pane; only a change of name animates it. The first paint
 * holds still; reduced motion keeps the fade and snaps the width.
 *
 * Inside a stacked heading (`data-stacked`, see useHeroHeadlineMotion) the
 * tail is a smaller line of its own, without the separator.
 */
export function HeroProjectSuffixText(props: {
  readonly name: string | null;
  /** The project's label color, for its folder icon. */
  readonly color: string | undefined;
}) {
  const [shown, setShown] = useState<Layer>({ key: 0, name: props.name, color: props.color });
  const [leaving, setLeaving] = useState<Layer | null>(null);
  if (props.name !== shown.name) {
    setLeaving(shown.name === null ? null : shown);
    setShown({ key: shown.key + 1, name: props.name, color: props.color });
  } else if (props.color !== shown.color) {
    // A recolor keeps the name in place; only the icon follows.
    setShown({ ...shown, color: props.color });
  }
  const boxRef = useRef<HTMLSpanElement>(null);
  const layerRef = useRef<HTMLSpanElement>(null);
  const leavingRef = useRef<HTMLSpanElement>(null);
  // A new name lands (shown.key): glide from the old name's width to the new
  // one's, both measured as laid out now, before paint.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (shown.key === 0 || !box) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const from = leavingRef.current?.offsetWidth ?? 0;
    const to = layerRef.current?.offsetWidth ?? 0;
    if (from === to) return;
    for (const animation of box.getAnimations()) animation.cancel();
    box.animate([{ width: `${from}px` }, { width: `${to}px` }], {
      duration: PANEL_ANIMATION_DURATION,
      easing: PANEL_MOTION_EASING,
    });
  }, [shown.key]);
  return (
    <span ref={boxRef} className="relative inline-block whitespace-nowrap text-start align-bottom">
      {leaving ? (
        <span
          key={leaving.key}
          ref={leavingRef}
          aria-hidden
          className="pointer-events-none absolute start-0 top-0 opacity-0 transition-opacity duration-(--motion-duration-base) ease-standard starting:opacity-100"
          onTransitionEnd={() => setLeaving(null)}
        >
          <SuffixContent name={leaving.name} color={leaving.color} />
        </span>
      ) : null}
      <span
        key={shown.key}
        ref={layerRef}
        data-hero-suffix-shown=""
        className={cn(
          "inline-block",
          shown.key > 0 &&
            "transition-opacity duration-(--motion-duration-base) ease-standard starting:opacity-0",
        )}
      >
        <SuffixContent name={shown.name} color={shown.color} />
      </span>
    </span>
  );
}

// Reads like the Work hero's project picker (InlineButton tone="picker"): the
// project's folder and name in the heading's color, underlined quietly.
function SuffixContent(props: {
  readonly name: string | null;
  readonly color: string | undefined;
}) {
  if (props.name === null) return null;
  return (
    <>
      <span
        aria-hidden
        className="whitespace-pre text-muted-foreground/60 group-data-stacked/hero-headline:hidden"
      >
        {" · "}
      </span>
      {"in "}
      <span className="underline decoration-foreground/30 decoration-from-font underline-offset-4 transition-colors duration-(--motion-duration-fast) group-hover/hero-suffix:decoration-foreground group-data-popup-open/hero-suffix:decoration-foreground">
        <ProjectFolderIcon
          color={props.color}
          className="inline-block"
          style={HERO_INLINE_ICON_STYLE}
        />
        {props.name}
      </span>
    </>
  );
}

import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "../lib/utils";

interface Layer {
  readonly key: number;
  readonly name: string | null;
}

/**
 * The chat hero's " · in <project>" tail. Its width glides to fit the new
 * name, so the centred greeting slides over rather than jumping, while the
 * old and new names crossfade in place: opacity only, nothing rises or
 * slides. The first paint holds still; reduced motion keeps the fade and
 * snaps the width.
 */
export function HeroProjectSuffixText(props: { readonly name: string | null }) {
  const [shown, setShown] = useState<Layer>({ key: 0, name: props.name });
  const [leaving, setLeaving] = useState<Layer | null>(null);
  if (props.name !== shown.name) {
    setLeaving(shown.name === null ? null : shown);
    setShown({ key: shown.key + 1, name: props.name });
  }
  const layerRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  // Width transitions switch on only after the first measured paint.
  const [glides, setGlides] = useState(false);
  // Re-measured whenever a new name lands (shown.key), before paint.
  useLayoutEffect(() => {
    setWidth(layerRef.current?.offsetWidth ?? 0);
  }, [shown.key]);
  useLayoutEffect(() => {
    if (width === null || glides) return;
    const frame = requestAnimationFrame(() => setGlides(true));
    return () => cancelAnimationFrame(frame);
  }, [glides, width]);
  return (
    <span
      className={cn(
        "relative inline-block whitespace-nowrap text-start align-bottom",
        glides &&
          "transition-[width] duration-(--motion-duration-base) ease-standard motion-reduce:transition-none",
      )}
      style={width === null ? undefined : { width }}
    >
      {leaving ? (
        <span
          key={leaving.key}
          aria-hidden
          className="pointer-events-none absolute start-0 top-0 opacity-0 transition-opacity duration-(--motion-duration-base) ease-standard starting:opacity-100"
          onTransitionEnd={() => setLeaving(null)}
        >
          <SuffixContent name={leaving.name} />
        </span>
      ) : null}
      <span
        key={shown.key}
        ref={layerRef}
        className={cn(
          "inline-block",
          shown.key > 0 &&
            "transition-opacity duration-(--motion-duration-base) ease-standard starting:opacity-0",
        )}
      >
        <SuffixContent name={shown.name} />
      </span>
    </span>
  );
}

function SuffixContent(props: { readonly name: string | null }) {
  if (props.name === null) return null;
  return (
    <>
      <span aria-hidden className="whitespace-pre">
        {" · "}
      </span>
      <span className="underline decoration-muted-foreground/30 decoration-from-font underline-offset-4 transition-colors duration-(--motion-duration-fast) group-hover/hero-suffix:decoration-muted-foreground group-data-popup-open/hero-suffix:decoration-muted-foreground">
        in {props.name}
      </span>
    </>
  );
}

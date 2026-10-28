import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * Glyphs tucked under one another like an avatar stack: a thread's providers,
 * or the sources a thread uses. Each glyph sits on a round chip in the
 * surrounding surface color with a ring of the same color, so the overlap
 * reads as a cut. The last item is drawn on top.
 *
 * The surface color is the `--provider-stack-ring` custom property. It defaults
 * to `--card`; the caller overrides it through `className` to match the surface
 * the stack sits on, including its hover and selected fills.
 *
 * `overflow` adds a "+N" for items left out. With `animateArrivals`, an item
 * that joins after the stack first rendered fades in (arrive-motion); items
 * present on first render, or when `scope` changes, just show.
 */
export function ProviderIconStack(props: {
  readonly items: ReadonlyArray<{ readonly key: string; readonly icon: ReactNode }>;
  readonly overflow?: number;
  readonly animateArrivals?: boolean;
  /** Resets what counts as already shown, e.g. per thread. */
  readonly scope?: string;
  readonly className?: string;
}) {
  // What has rendered, updated on commit so a repeated render reads the same.
  const shown = useRef<{ scope: string | undefined; keys: ReadonlySet<string> } | null>(null);
  // Items that arrived keep their class, so a later render cannot cut the fade short.
  const arrived = useRef(new Set<string>());
  const sameScope = shown.current !== null && shown.current.scope === props.scope;
  const isArrival = (key: string) =>
    props.animateArrivals === true &&
    sameScope &&
    (arrived.current.has(key) || !shown.current!.keys.has(key));
  useEffect(() => {
    if (!sameScope) arrived.current = new Set();
    for (const item of props.items) {
      if (isArrival(item.key)) arrived.current.add(item.key);
    }
    shown.current = { scope: props.scope, keys: new Set(props.items.map((item) => item.key)) };
  });
  const overflow = props.overflow ?? 0;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center [--provider-stack-ring:var(--card)]",
        props.className,
      )}
    >
      {props.items.map((item, index) => (
        <span
          key={item.key}
          // `isolate` keeps each glyph's own z-index inside its chip, so later
          // chips paint over earlier ones whole, glyph and all.
          className={cn(
            // A 1px ring and a 4px tuck keep the cut a hairline, so the glyph
            // underneath stays recognizable rather than cropped in half.
            "relative isolate inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-(--provider-stack-ring) ring-1 ring-(--provider-stack-ring)",
            // The chip follows the surface's hover and selected fills.
            "motion-safe:transition-[background-color,box-shadow] motion-safe:duration-(--motion-duration-fast) motion-safe:ease-standard",
            isArrival(item.key) && "arrive-motion",
            index > 0 && "-ml-1",
          )}
        >
          {item.icon}
        </span>
      ))}
      {overflow > 0 ? (
        <span className="ms-1 shrink-0 text-xs font-medium text-muted-foreground tabular-nums">
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}

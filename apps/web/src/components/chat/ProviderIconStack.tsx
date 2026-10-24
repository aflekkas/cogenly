import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * Provider glyphs tucked under one another like an avatar stack. Each glyph sits
 * on a round chip in the surrounding surface color with a ring of the same
 * color, so the overlap reads as a cut. Items run oldest to newest: the last is
 * drawn on top, since it is the provider the thread runs on now.
 *
 * The surface color is the `--provider-stack-ring` custom property. It defaults
 * to `--card`; the caller overrides it through `className` to match the surface
 * the stack sits on, including its hover and selected fills.
 */
export function ProviderIconStack(props: {
  readonly items: ReadonlyArray<{ readonly key: string; readonly icon: ReactNode }>;
  readonly className?: string;
}) {
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
            index > 0 && "-ml-1",
          )}
        >
          {item.icon}
        </span>
      ))}
    </span>
  );
}

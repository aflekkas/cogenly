import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";

/**
 * Shared settings card surface, with optional separators between rows.
 * - `grouped`: a section's raised card.
 * - `inset`: a bordered box nested inside a row or a detail pane (a row's
 *   list of items, an editor's fields). Flat, so the card around it stays the
 *   one raised layer. Every nested box uses this instead of its own border.
 * - `plain`: no surface, rows spaced apart.
 */
export function SettingsGroup({
  variant = "grouped",
  divided = true,
  className,
  ...props
}: ComponentProps<"div"> & {
  variant?: "grouped" | "inset" | "plain";
  divided?: boolean;
}) {
  const boxed = variant !== "plain";
  return (
    <div
      {...props}
      data-settings-group={variant}
      className={cn(
        "relative overflow-visible text-foreground",
        variant === "grouped" && "surface-raised rounded-xl border bg-card/40",
        variant === "inset" && "rounded-lg border border-border/60",
        variant === "plain" && "space-y-1",
        boxed &&
          divided &&
          "[&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none",
        // An empty or emptying `AnimatedHeight` row draws no separator of its
        // own, and as the first row it leaves none on the row below it either.
        boxed &&
          divided &&
          "[&>[data-slot=animated-height][data-empty]]:border-t-transparent [&>[data-slot=animated-height]:first-child[data-empty]+*]:border-t-transparent",
        className,
      )}
    />
  );
}

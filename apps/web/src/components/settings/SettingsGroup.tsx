import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";

/** Shared settings card surface, with optional separators between rows. */
export function SettingsGroup({
  variant = "grouped",
  divided = true,
  className,
  ...props
}: ComponentProps<"div"> & {
  variant?: "grouped" | "plain";
  divided?: boolean;
}) {
  return (
    <div
      {...props}
      data-settings-group={variant}
      className={cn(
        "relative overflow-visible text-foreground",
        variant === "grouped" ? "surface-raised rounded-xl border bg-card/40" : "space-y-1",
        variant === "grouped" &&
          divided &&
          "[&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none",
        // A collapsed `AnimatedHeight` row draws no separator of its own, and as
        // the first row it leaves none on the row below it either.
        variant === "grouped" &&
          divided &&
          "[&>[data-slot=animated-height]:has(>:empty)]:border-t-transparent [&>[data-slot=animated-height]:first-child:has(>:empty)+*]:border-t-transparent",
        className,
      )}
    />
  );
}

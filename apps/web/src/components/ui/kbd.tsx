import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const kbdVariants = cva(
  "pointer-events-none inline-flex select-none items-center justify-center gap-1 rounded font-medium font-sans whitespace-nowrap [&_svg:not([class*='size-'])]:size-3",
  {
    variants: {
      variant: {
        default: "bg-muted text-muted-foreground",
        outline: "border border-border bg-background text-foreground",
      },
      size: {
        default: "h-5 min-w-5 px-1 text-xs",
        sm: "h-4 min-w-4 px-1 text-xs leading-none",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Kbd({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"kbd"> & VariantProps<typeof kbdVariants>) {
  return (
    <kbd className={cn(kbdVariants({ variant, size }), className)} data-slot="kbd" {...props} />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn("inline-flex items-center gap-1", className)}
      data-slot="kbd-group"
      {...props}
    />
  );
}

export { Kbd, KbdGroup };

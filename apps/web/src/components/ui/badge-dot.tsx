import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";
import { useLastPresent } from "./overlay-presence";

export type BadgeDotTone = "info" | "success" | "warning" | "destructive" | "primary" | "current";

const toneClassName: Record<BadgeDotTone, string> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  primary: "bg-primary",
  current: "bg-current",
};

const badgeDotVariants = cva(
  "pointer-events-none rounded-full transition-[opacity,scale,background-color] duration-(--motion-duration-fast) ease-out motion-reduce:transition-opacity",
  {
    defaultVariants: { size: "sm", ring: "none" },
    variants: {
      size: {
        sm: "size-1.5",
        md: "size-2",
      },
      /** A knockout ring in the surface colour, for dots that overlap their icon. */
      ring: {
        none: "",
        background: "ring-2 ring-background",
        "nav-rail": "ring-2 ring-nav-rail",
      },
    },
  },
);

/**
 * The status or notification dot on an icon (unread, running, update ready).
 * It stays mounted: a dot that appears fades and scales up from 0.6, one that
 * clears runs the same motion back in its last colour, and a colour change
 * crossfades. Only live changes move; a dot that is already showing when it
 * mounts paints still. Opacity only under reduced motion. The parent places
 * it (`absolute top-1 right-1`) and must be `relative`.
 */
export function BadgeDot({
  tone,
  size,
  ring,
  className,
}: VariantProps<typeof badgeDotVariants> & {
  /** The colour to show, or nothing to hide the dot. */
  tone: BadgeDotTone | null | undefined | false;
  className?: string;
}) {
  const shown = tone || null;
  const painted = useLastPresent(shown);
  return (
    <span
      aria-hidden
      data-slot="badge-dot"
      data-visible={shown ? "" : undefined}
      className={cn(
        badgeDotVariants({ size, ring }),
        painted ? toneClassName[painted] : undefined,
        shown ? "scale-100 opacity-100" : "scale-60 opacity-0 motion-reduce:scale-100",
        className,
      )}
    />
  );
}

import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";
import { useLastPresent } from "./overlay-presence";

export type BadgeDotTone =
  | "info"
  | "success"
  | "warning"
  | "destructive"
  | "primary"
  | "muted"
  | "current";

const toneClassName: Record<BadgeDotTone, string> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  primary: "bg-primary",
  muted: "bg-muted-foreground/45",
  current: "bg-current",
};

const badgeDotVariants = cva(
  "pointer-events-none rounded-full transition-[opacity,background-color] duration-(--motion-duration-fast) ease-out motion-reduce:transition-opacity",
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
        popover: "ring-2 ring-popover",
      },
    },
  },
);

/**
 * The status or notification dot on a row or icon. One primitive for every
 * dot so they read alike: `info` (blue) is unread news, `warning` (amber) is
 * something waiting on you and outranks unread, `destructive` (red) is an
 * alert. It stays mounted: a dot that appears fades in, one that clears fades
 * out in its last colour, and a colour change crossfades. Opacity only, and
 * only live changes move; a dot already showing when it mounts paints still.
 * The parent places it (`absolute top-2 right-2` on a rail icon) and must be
 * `relative`.
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
        shown ? "opacity-100" : "opacity-0",
        className,
      )}
    />
  );
}

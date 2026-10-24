import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

// No default size: inside a Button the parent's svg rule sizes the glyph.
const animatedIconVariants = cva("", {
  variants: {
    size: {
      xs: "size-3",
      sm: "size-3.5",
      md: "size-4",
      lg: "size-5",
    },
  },
});

type AnimatedIconProps = Omit<React.ComponentPropsWithoutRef<"svg">, "children"> &
  VariantProps<typeof animatedIconVariants>;

/** Lucide's stroke attributes, so these glyphs sit beside lucide icons unchanged. */
const LUCIDE_SVG = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/**
 * Lucide's MousePointerClick for a pick-on-page control. Hovering its button
 * bursts the click rays out from the tip once and nudges the arrow; `active`
 * fades the arrow to a tinted fill and back. The motion lives in index.css
 * (pick-icon), so it needs to be the button's direct child.
 */
export function PickElementIcon({
  active = false,
  className,
  size,
  ...props
}: AnimatedIconProps & { active?: boolean }) {
  return (
    <svg
      aria-hidden
      {...LUCIDE_SVG}
      data-active={active ? "" : undefined}
      className={cn(
        "pick-icon",
        active && "text-brand-accent",
        animatedIconVariants({ size }),
        className,
      )}
      {...props}
    >
      <g className="pick-icon-rays">
        <path d="M14 4.1 12 6" />
        <path d="m5.1 8-2.9-.8" />
        <path d="m6 12-1.9 2" />
        <path d="M7.2 2.2 8 5.1" />
      </g>
      <path
        className="pick-icon-arrow"
        d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"
      />
    </svg>
  );
}

/**
 * Lucide's Camera for a capture control. Each change of `shot` (bump it when
 * a screenshot is taken) closes and reopens the lens with a brief flash; 0
 * stays still, so mounting never plays it. Reduced motion keeps the flash.
 */
export function CaptureIcon({
  shot = 0,
  recording = false,
  className,
  size,
  ...props
}: AnimatedIconProps & { shot?: number; recording?: boolean }) {
  return (
    <svg
      aria-hidden
      {...LUCIDE_SVG}
      className={cn(recording && "text-destructive", animatedIconVariants({ size }), className)}
      {...props}
    >
      <path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" />
      {/* A new key restarts the shutter on every shot. */}
      <circle
        key={shot}
        className="capture-icon-lens"
        data-shot={shot > 0 ? "" : undefined}
        cx="12"
        cy="13"
        r="3"
      />
    </svg>
  );
}

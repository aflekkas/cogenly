"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "~/lib/utils";
import { useAnimatedPanelHeight } from "./animated-panel-height";

const PopoverCreateHandle = PopoverPrimitive.createHandle;

const Popover = PopoverPrimitive.Root;

function PopoverTrigger({ className, children, ...props }: PopoverPrimitive.Trigger.Props) {
  return (
    <PopoverPrimitive.Trigger className={className} data-slot="popover-trigger" {...props}>
      {children}
    </PopoverPrimitive.Trigger>
  );
}

// Popovers hold prose and forms, so a width is fixed rather than a minimum,
// and every width is capped to the viewport.
const popoverPopupWidthClassName = {
  auto: "",
  sm: "w-64",
  md: "w-80",
  lg: "w-96",
} as const;

// The inset around the content. "compact" suits dense content (a list, a code excerpt, a
// row of reactions); "none" is for content that draws its own frame edge to edge.
const popoverViewportPaddingClassName = {
  default: "py-4 [--viewport-inline-padding:--spacing(4)]",
  compact: "py-2 [--viewport-inline-padding:--spacing(3)]",
  // Rounded to the popup so edge-to-edge content clips to its corners.
  none: "rounded-[calc(var(--radius-lg)-1px)] py-0 [--viewport-inline-padding:0px]",
} as const;

function PopoverPopup({
  children,
  className,
  padding = "default",
  variant = "default",
  width = "auto",
  side = "bottom",
  align = "center",
  sideOffset = 4,
  alignOffset = 0,
  collisionAvoidance,
  collisionPadding,
  tooltipStyle = false,
  bubble = false,
  keepMounted = false,
  anchor,
  animateHeight,
  ...props
}: PopoverPrimitive.Popup.Props & {
  padding?: keyof typeof popoverViewportPaddingClassName;
  variant?: "default" | "panel";
  side?: PopoverPrimitive.Positioner.Props["side"];
  align?: PopoverPrimitive.Positioner.Props["align"];
  sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: PopoverPrimitive.Positioner.Props["alignOffset"];
  collisionAvoidance?: PopoverPrimitive.Positioner.Props["collisionAvoidance"];
  /** Space kept between the popup and the viewport edge; panels default to 0. */
  collisionPadding?: PopoverPrimitive.Positioner.Props["collisionPadding"];
  tooltipStyle?: boolean;
  /**
   * A calmer, rounder entrance for small previews such as a quoted source: grows from 0.94 at the
   * anchor on a soft spring and leaves faster. Reduced motion fades only.
   */
  bubble?: boolean;
  keepMounted?: PopoverPrimitive.Portal.Props["keepMounted"];
  anchor?: PopoverPrimitive.Positioner.Props["anchor"];
  width?: keyof typeof popoverPopupWidthClassName;
  /**
   * Glide to the content's new height when it changes while open (useAnimatedPanelHeight).
   * On by default; panels, and pickers that hold a fixed size, pass false.
   */
  animateHeight?: boolean;
}) {
  const animatesHeight = animateHeight ?? variant !== "panel";
  const { panelProps, contentRef } = useAnimatedPanelHeight(animatesHeight);
  // Viewport rekeys its children when the active trigger clears on close. Persistent
  // single-trigger forms need a stable container to retain drafts and submit guards.
  const Viewport = keepMounted ? "div" : PopoverPrimitive.Viewport;
  const viewport = (
    <Viewport
      ref={animatesHeight ? contentRef : undefined}
      className={cn(
        // Animated, the viewport keeps its natural height inside the panel that animates.
        animatesHeight ? "w-full" : "size-full",
        "relative max-h-(--available-height) overflow-clip px-(--viewport-inline-padding) has-data-[slot=calendar]:p-2 data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity",
        tooltipStyle && padding === "default"
          ? "py-1 [--viewport-inline-padding:--spacing(2)]"
          : popoverViewportPaddingClassName[padding],
        !tooltipStyle && "scroll-fade-y not-data-transitioning:overflow-y-auto",
        variant === "panel" && "overflow-visible py-2 [--viewport-inline-padding:--spacing(2)]",
      )}
      data-slot="popover-viewport"
    >
      {children}
    </Viewport>
  );
  return (
    <PopoverPrimitive.Portal keepMounted={keepMounted}>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
        // A panel's card already sits inside its own padding, so the panel can reach the edge.
        collisionPadding={collisionPadding ?? (variant === "panel" ? 0 : undefined)}
        className={cn(
          "h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-transform data-instant:transition-none",
          variant === "panel"
            ? // The card inside is the panel width, or the anchor less 12px per side; the viewport
              // pads it by --spacing(2) per side. Panels slide when their offset changes, e.g. to make
              // room for a bar below the header, even when opened from the keyboard (data-instant).
              "z-(--z-sheet) w-[min(calc(var(--thread-details-panel-width)+--spacing(4)),calc(var(--anchor-width)---spacing(2)))] transition-[top] duration-150 ease-out data-instant:transition-[top] motion-reduce:transition-none motion-reduce:data-instant:transition-none"
            : "z-[130]",
        )}
        data-slot="popover-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          className={cn(
            "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-lg text-popover-foreground outline-none popup-motion transition-[width,height,opacity,scale,translate] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] has-data-[slot=calendar]:rounded-xl has-data-[slot=calendar]:before:rounded-[calc(var(--radius-xl)-1px)]",
            variant !== "panel" && "dropdown-glass surface-raised surface-raised-floating",
            tooltipStyle &&
              "w-fit text-balance rounded-md text-xs before:rounded-[calc(var(--radius-md)-1px)]",
            bubble &&
              "rounded-xl before:rounded-[calc(var(--radius-xl)-1px)] [--tw-duration:180ms]! [--tw-ease:cubic-bezier(0.34,1.3,0.64,1)]! data-ending-style:[--tw-duration:110ms]! data-ending-style:[--tw-ease:var(--ease-popup-exit)]! data-ending-style:scale-95! data-starting-style:scale-94! motion-reduce:data-ending-style:scale-100! motion-reduce:data-starting-style:scale-100!",
            width !== "auto" && ["max-w-[calc(100vw-2rem)]", popoverPopupWidthClassName[width]],
            variant === "panel" &&
              "w-full overflow-visible rounded-none border-0 bg-transparent shadow-none before:hidden",
            className,
          )}
          data-slot="popover-popup"
          {...props}
        >
          {animatesHeight ? (
            // The panel animates to the viewport's height; the viewport still clamps and scrolls.
            <div className="panel-height-motion w-full" data-slot="popover-panel" {...panelProps}>
              {viewport}
            </div>
          ) : (
            viewport
          )}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverClose({ ...props }: PopoverPrimitive.Close.Props) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      className={cn("font-semibold text-sm leading-none", className)}
      data-slot="popover-title"
      {...props}
    />
  );
}

export {
  PopoverCreateHandle,
  Popover,
  PopoverTrigger,
  PopoverPopup,
  PopoverPopup as PopoverContent,
  PopoverTitle,
  PopoverClose,
};

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
  createContext,
  use,
  useEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { useNativeTitlebarHeight } from "~/lib/windowControlsOverlay";

// Base UI's default, restated because a padding object zeroes the sides it omits.
const COLLISION_PADDING = 5;

const TooltipProvider = TooltipPrimitive.Provider;

/** One tooltip shared by many triggers: it glides between them instead of re-opening. */
const createTooltipHandle = TooltipPrimitive.createHandle;
type TooltipHandle<Payload> = TooltipPrimitive.Handle<Payload>;

type TooltipActionsRef = RefObject<TooltipPrimitive.Root.Actions | null>;
const TooltipHoverContext = createContext<TooltipActionsRef | null>(null);
const TooltipScrollContext = createContext<RefObject<{
  trigger: HTMLElement;
  actionsRef: TooltipActionsRef;
} | null> | null>(null);

/** Dismisses hovered descendants on real scroll events without rerendering the timeline. */
function TooltipScrollDismissArea({ onScrollCapture, ...props }: ComponentProps<"div">) {
  const hovered = useRef<{ trigger: HTMLElement; actionsRef: TooltipActionsRef } | null>(null);
  return (
    <TooltipScrollContext value={hovered}>
      <div
        {...props}
        onScrollCapture={(event) => {
          onScrollCapture?.(event);
          const tooltip = hovered.current;
          if (!tooltip || tooltip.trigger.contains(tooltip.trigger.ownerDocument.activeElement)) {
            return;
          }
          hovered.current = null;
          // Base UI also cancels delayed hover opens through this action.
          tooltip.actionsRef.current?.close();
        }}
      />
    </TooltipScrollContext>
  );
}

function Tooltip<Payload>(props: TooltipPrimitive.Root.Props<Payload>) {
  const hovered = use(TooltipScrollContext);
  const localActionsRef = useRef<TooltipPrimitive.Root.Actions | null>(null);
  const actionsRef = props.actionsRef ?? localActionsRef;
  useEffect(
    () => () => {
      if (hovered?.current?.actionsRef === actionsRef) hovered.current = null;
    },
    [actionsRef, hovered],
  );

  if (!hovered) return <TooltipPrimitive.Root {...props} />;
  return (
    <TooltipHoverContext value={actionsRef}>
      <TooltipPrimitive.Root
        {...props}
        actionsRef={actionsRef}
        onOpenChange={(open, details) => {
          props.onOpenChange?.(open, details);
          if (!open && !details.isCanceled && hovered.current?.actionsRef === actionsRef) {
            hovered.current = null;
          }
        }}
      />
    </TooltipHoverContext>
  );
}

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  const hovered = use(TooltipScrollContext);
  const actionsRef = use(TooltipHoverContext);
  if (!hovered || !actionsRef) {
    return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
  }
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      onMouseEnter={(event) => {
        props.onMouseEnter?.(event);
        hovered.current = { trigger: event.currentTarget, actionsRef };
      }}
    />
  );
}

/**
 * Treats the native titlebar strip as off-screen, so a tooltip that would open
 * under the window controls flips to its other side. Rendered inside the
 * portal so only open tooltips track the titlebar.
 */
function TooltipPositioner(props: TooltipPrimitive.Positioner.Props) {
  const titlebarHeight = useNativeTitlebarHeight();
  return (
    <TooltipPrimitive.Positioner
      className="pointer-events-none z-[140] h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none"
      collisionPadding={{
        top: COLLISION_PADDING + titlebarHeight,
        right: COLLISION_PADDING,
        bottom: COLLISION_PADDING,
        left: COLLISION_PADDING,
      }}
      data-slot="tooltip-positioner"
      {...props}
    />
  );
}

/** The text of a tooltip whose label is a plain string, else null. */
function plainLabel(children: ReactNode): string | null {
  return typeof children === "string" ? children : null;
}

/**
 * A tooltip that turns into "Copied" confirms a copy, so it pops the way the anchored "Copied!"
 * toast does: a small spring from 0.85 with a slight overshoot. Reduced motion skips it.
 */
function usePopWhenCopied(label: string | null) {
  const popupRef = useRef<HTMLDivElement>(null);
  const copied = label !== null && /^copied/i.test(label);
  useEffect(() => {
    const popup = popupRef.current;
    if (!copied || !popup || typeof popup.animate !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const pop = popup.animate(
      [
        { transform: "scale(0.85)" },
        { transform: "scale(1.06)", offset: 0.6 },
        { transform: "scale(1)" },
      ],
      { duration: 260, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
    );
    return () => pop.cancel();
  }, [copied]);
  return popupRef;
}

function TooltipPopup({
  className,
  align = "center",
  sideOffset = 4,
  side = "top",
  variant = "default",
  anchor,
  collisionBoundary,
  children,
  ...props
}: TooltipPrimitive.Popup.Props & {
  align?: TooltipPrimitive.Positioner.Props["align"];
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
  /** `code` renders monospace content that breaks anywhere, for paths and commands. */
  variant?: "default" | "glass" | "code";
  anchor?: TooltipPrimitive.Positioner.Props["anchor"];
  /**
   * What the tooltip must fit inside before it flips. Defaults to the trigger's
   * clipping ancestors; pass `[]` to flip against the viewport alone when the
   * trigger sits in an overflow-clip box that never scrolls.
   */
  collisionBoundary?: TooltipPrimitive.Positioner.Props["collisionBoundary"];
}) {
  const popupRef = usePopWhenCopied(plainLabel(children));
  return (
    <TooltipPrimitive.Portal>
      <TooltipPositioner
        align={align}
        anchor={anchor}
        side={side}
        sideOffset={sideOffset}
        {...(collisionBoundary !== undefined ? { collisionBoundary } : {})}
      >
        <TooltipPrimitive.Popup
          ref={popupRef}
          className={cn(
            "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-balance rounded-md text-popover-foreground text-xs popup-motion transition-[width,height,opacity,scale,translate] [--popup-motion-offset:2px] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-instant:duration-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            variant === "glass"
              ? "dropdown-glass surface-raised surface-raised-floating before:hidden"
              : "border bg-popover surface-raised surface-raised-floating before:hidden",
            // One wrap width for prose; code dumps get more room and break anywhere.
            variant === "code"
              ? "max-w-120 wrap-anywhere text-left font-mono text-[11px] leading-relaxed"
              : "max-w-80 wrap-anywhere whitespace-normal leading-snug",
            className,
          )}
          data-slot="tooltip-popup"
          {...props}
        >
          <TooltipPrimitive.Viewport
            className="relative size-full overflow-clip px-(--viewport-inline-padding) py-1 [--viewport-inline-padding:--spacing(2)] data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:truncate **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity"
            data-slot="tooltip-viewport"
          >
            {children}
          </TooltipPrimitive.Viewport>
        </TooltipPrimitive.Popup>
      </TooltipPositioner>
    </TooltipPrimitive.Portal>
  );
}

export {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
  TooltipScrollDismissArea,
  createTooltipHandle,
};
export type { TooltipHandle };

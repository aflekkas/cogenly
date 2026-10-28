import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useReducedMotion } from "~/appearancePreferences";
import { cn } from "~/lib/utils";
import {
  disclosureDuration,
  disclosureExitDue,
  disclosurePanelPresent,
  initialDisclosurePanelState,
  reconcileDisclosurePanel,
  settleDisclosurePanel,
} from "./disclosure.logic";
import { useLastPresent } from "./overlay-presence";

/**
 * The app's one disclosure convention: a small chevron that points right when
 * closed and turns to point down (90°) when open, rotating in step with the
 * content it reveals. Anything that expands in place (timeline rows, work-log
 * groups, settings folds, sidebar sections) uses these three pieces:
 *
 * - `DisclosureChevron`: the glyph. Pass `open` when the caller owns the
 *   state. Omit it inside a Base UI `CollapsibleTrigger` or a `<details>`
 *   summary and it follows `data-panel-open` / `open` on its own.
 * - `DisclosureTrigger`: a button carrying `aria-expanded`, the focus ring and
 *   the chevron. Works standalone (`open`, `onClick`) or as a Base UI trigger's
 *   `render` element.
 * - `DisclosurePanel`: grows the content from zero height while fading it in,
 *   and runs the same motion back on close. Opacity only under reduced motion.
 */

const revealClassName =
  "opacity-0 group-hover/timeline-row:opacity-70 group-focus-visible/timeline-row:opacity-70 group-hover/disclosure:opacity-70 group-focus-visible/disclosure:opacity-70";

export function DisclosureChevron({
  open,
  reveal = false,
}: {
  /** Open state. Omit it to follow the surrounding Base UI trigger or `<details>`. */
  open?: boolean | undefined;
  /** Keeps a closed chevron hidden until its row (`group/timeline-row` or `group/disclosure`) is hovered or focused. */
  reveal?: boolean;
}) {
  return (
    <ChevronRightIcon
      aria-hidden
      data-slot="disclosure-chevron"
      className={cn(
        "size-3 shrink-0 text-icon-muted transition-[rotate,opacity] ease-standard motion-reduce:transition-none",
        open === undefined
          ? "[[data-panel-open]_&]:rotate-90 [details[open]>summary_&]:rotate-90"
          : open && "rotate-90",
        reveal && !open ? revealClassName : "opacity-70",
      )}
      style={disclosureDuration(open ?? true)}
    />
  );
}

const disclosureTriggerVariants = cva(
  "group/disclosure flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md text-left select-none transition-colors duration-(--motion-duration-fast) ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 motion-reduce:transition-none",
  {
    defaultVariants: { variant: "inherit" },
    variants: {
      variant: {
        /** Takes the surrounding text; for headers and rows that set their own type. */
        inherit: "",
        /** A quiet nested disclosure inside other content ("Raw"): small and muted, bright on hover. */
        quiet: "text-xs text-muted-foreground hover:text-foreground",
      },
    },
  },
);

export function DisclosureTrigger({
  open,
  chevron = "end",
  reveal = false,
  variant,
  className,
  children,
  render,
  ...props
}: useRender.ComponentProps<"button"> &
  VariantProps<typeof disclosureTriggerVariants> & {
    /** Open state. Omit it when a Base UI `CollapsibleTrigger` renders this and supplies it. */
    open?: boolean | undefined;
    /** Where the chevron sits relative to the children; "none" lets the caller place its own. */
    chevron?: "start" | "end" | "none";
    /** Reveal the chevron on hover and focus only, for dense rows that would otherwise fill with chevrons. */
    reveal?: boolean;
  }) {
  const defaultProps = {
    type: render ? undefined : ("button" as const),
    "aria-expanded": open,
    "data-slot": "disclosure-trigger",
    className: cn(disclosureTriggerVariants({ variant }), className),
    children: (
      <>
        {chevron === "start" ? <DisclosureChevron open={open} reveal={reveal} /> : null}
        {children}
        {chevron === "end" ? <DisclosureChevron open={open} reveal={reveal} /> : null}
      </>
    ),
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

/** Longest disclosure motion (--motion-duration-base); a close that never fires transitionend still unmounts after it. */
const DISCLOSURE_MOTION_MS = 220;

/**
 * Grows disclosure content from zero height and fades it in; closing runs the
 * same motion back and unmounts once it ends, holding the last open content
 * meanwhile. Only an open that happens after mount animates, or the first one
 * when `appear` is set, so virtualized rows that remount open stay still.
 * `onExitComplete` fires once content this panel showed has left, never for a
 * panel that mounted closed. `layout="group-content"` carries an expanded
 * timeline group's trailing space: while closing it grows to the gap the
 * collapsed header will own, so removing the row afterwards moves nothing.
 * Reduced motion changes height at once and only fades an open in.
 */
export function DisclosurePanel({
  open,
  appear = false,
  layout = "row",
  continues = false,
  onExitComplete,
  children,
}: {
  open: boolean;
  appear?: boolean;
  layout?: "row" | "group-content";
  continues?: boolean | undefined;
  onExitComplete?: (() => void) | undefined;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const [state, setState] = useState(() => initialDisclosurePanelState(open, appear));
  const held = useLastPresent(open ? children : null);
  if (state.open !== open) setState(reconcileDisclosurePanel(state, open));
  const present = disclosurePanelPresent(state, reducedMotion);
  const onExitCompleteRef = useRef(onExitComplete);
  useLayoutEffect(() => {
    onExitCompleteRef.current = onExitComplete;
  });
  // Whether content this panel rendered is still waiting to report its exit.
  const shownRef = useRef(present);
  // Reports the close once the content it showed is gone, including a close
  // under reduced motion. Owners fall back to a timer for panels that never
  // showed anything (mounted closed, or scrolled out of the list).
  useEffect(() => {
    if (present) {
      shownRef.current = true;
      return;
    }
    if (!disclosureExitDue(open, present, shownRef.current)) return;
    shownRef.current = false;
    onExitCompleteRef.current?.();
  }, [open, present]);
  // A transition that never starts (hidden tab, interrupted style) still settles.
  useEffect(() => {
    if (!state.moving) return;
    const timer = setTimeout(() => setState(settleDisclosurePanel), DISCLOSURE_MOTION_MS + 100);
    return () => clearTimeout(timer);
  }, [state.moving]);
  if (!present) return null;
  const gapClassName =
    layout === "group-content" && !continues ? (open ? "pb-1" : "pb-2") : undefined;
  const { animateEnter, moving } = state;
  if (reducedMotion) {
    // Height changes at once; an open still fades in, like every other surface.
    return (
      <div
        className={cn(
          gapClassName,
          animateEnter &&
            "transition-opacity duration-(--motion-duration-fast) ease-out starting:opacity-0",
        )}
      >
        {children}
      </div>
    );
  }
  return (
    <div
      inert={!open}
      data-slot="disclosure-panel"
      style={disclosureDuration(open)}
      className={cn(
        // minmax(0, 1fr) keeps the column at the panel's width; an auto column
        // grows to unwrapped content and overflows the parent sideways.
        "grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows,padding] ease-standard",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        animateEnter && "starting:grid-rows-[0fr]",
        animateEnter && layout === "group-content" && !continues && "starting:pb-2",
        gapClassName,
      )}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") {
          return;
        }
        setState(settleDisclosurePanel);
      }}
    >
      {/* Clipped only while moving, so focus rings and shadows show at rest. */}
      <div
        className={cn(
          "min-h-0 transition-opacity ease-standard",
          open ? "opacity-100" : "opacity-0",
          animateEnter && "starting:opacity-0",
          (moving || !open) && "overflow-hidden",
        )}
        style={disclosureDuration(open)}
      >
        {open ? children : held}
      </div>
    </div>
  );
}

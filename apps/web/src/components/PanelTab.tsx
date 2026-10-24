import { Check, X } from "lucide-react";
import { type ComponentProps, createContext, type ReactNode, use } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import type { PanelTabStatus } from "./TabStrip.logic";

/**
 * What TabStrip hands each tab's slots: its name, the close action the icon
 * slot turns into, and what the title's tooltip says.
 */
export interface PanelTabContextValue {
  readonly label: string;
  readonly onClose: (() => void) | undefined;
  readonly tooltip: ReactNode;
}

export const PanelTabContext = createContext<PanelTabContextValue | null>(null);

/**
 * The look of a closable tab in a TabStrip (the right panel's browser, file
 * and device tabs, the bottom drawer's agent tabs), after T3 Code's panel
 * tabs: compact and as wide as its title, icon first, the selected one a
 * quiet fill. Its × lives in the icon slot: on hover or keyboard focus the
 * icon fades and shrinks out as the × fades and grows in, so no trailing
 * button takes width from the title. Colours fade on the fast token; reduced
 * motion keeps only the opacity.
 *
 * Slots carry the styling; TabStrip owns behaviour (roles, focus, drag,
 * overflow, close, tooltip) and places them. Layout classes go through `className`.
 */
function Body({ active, className, ...props }: ComponentProps<"div"> & { active: boolean }) {
  return (
    <div
      data-slot="panel-tab"
      data-active={active ? "" : undefined}
      className={cn(
        "group/panel-tab flex h-6 min-w-0 items-center gap-0.5 rounded-md ps-1.5 pe-2 text-xs transition-colors duration-(--motion-duration-fast) ease-out",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

// The icon and the × share the slot. Keyboard focus is spelled out as a
// selector rather than `group-focus-visible`: TabStrip marks its tablist
// `data-pointer-focus` while focus came from the pointer, so a clicked tab
// never takes the keyboard look even where the browser still matches
// :focus-visible (a refocused window, focus moved after a shortcut).
// Reduced motion keeps the crossfade and drops the scale. Whichever layer is
// arriving waits 50ms (a transition takes the delay of the state it enters),
// so the outgoing one is mostly gone first and the swap reads as a crossfade
// rather than a snap: 200ms in all, both ways.
const SWAP_LAYER =
  "absolute inset-0 flex items-center justify-center transition-[opacity,scale] duration-(--motion-duration-fast) ease-out";

/**
 * The tab's icon or favicon, at 12px in a 16px slot. In a closable tab the
 * slot is the close button: the × crossfades over the icon (and any badge on
 * it) while the tab is hovered or keyboard-focused. Not a tab stop, since
 * Delete closes the focused tab.
 */
function Icon({ className, children, ...props }: ComponentProps<"span">) {
  const tab = use(PanelTabContext);
  const glyph = (
    <span className="relative flex size-3 items-center justify-center [&_img]:size-3 [&_svg]:size-3">
      {children}
    </span>
  );
  if (!tab?.onClose) {
    return (
      <span
        data-slot="panel-tab-icon"
        className={cn("relative flex size-4 shrink-0 items-center justify-center", className)}
        {...props}
      >
        {glyph}
      </span>
    );
  }
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`Close ${tab.label}`}
      data-slot="panel-tab-icon"
      onClick={tab.onClose}
      className={cn(
        "relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm outline-none transition-colors duration-(--motion-duration-fast) ease-out hover:bg-muted",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          SWAP_LAYER,
          "delay-50 group-hover/panel-tab:opacity-0 group-hover/panel-tab:delay-0 motion-safe:group-hover/panel-tab:scale-75",
          "[[role=tablist]:not([data-pointer-focus])_[role=tab]:focus-visible_&]:opacity-0 [[role=tablist]:not([data-pointer-focus])_[role=tab]:focus-visible_&]:delay-0 motion-safe:[[role=tablist]:not([data-pointer-focus])_[role=tab]:focus-visible_&]:scale-75",
        )}
      >
        {glyph}
      </span>
      <span
        aria-hidden
        className={cn(
          SWAP_LAYER,
          "opacity-0 group-hover/panel-tab:opacity-100 group-hover/panel-tab:delay-50 motion-safe:scale-75 motion-safe:group-hover/panel-tab:scale-100",
          "[[role=tablist]:not([data-pointer-focus])_[role=tab]:focus-visible_&]:opacity-100 [[role=tablist]:not([data-pointer-focus])_[role=tab]:focus-visible_&]:delay-50 motion-safe:[[role=tablist]:not([data-pointer-focus])_[role=tab]:focus-visible_&]:scale-100",
        )}
      >
        <X className="size-3" />
      </span>
    </button>
  );
}

/**
 * The title; it truncates at the tab's maximum width, and in a TabStrip
 * shows the full title (or the strip's richer tooltip) on hover.
 */
function Label({ className, ...props }: ComponentProps<"span">) {
  const tab = use(PanelTabContext);
  const label = (
    <span
      data-slot="panel-tab-label"
      className={cn("min-w-0 flex-1 truncate text-left", className)}
      {...props}
    />
  );
  if (!tab) return label;
  return (
    <Tooltip>
      <TooltipTrigger render={label} />
      <TooltipPopup>{tab.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/** A small icon button that stays in view, such as a tab's mute toggle. */
function Action({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-slot="panel-tab-action"
      className={cn(
        "flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm outline-none transition-colors duration-(--motion-duration-fast) ease-out hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        className,
      )}
      {...props}
    />
  );
}

/**
 * What the work behind the tab is doing, after its title: a small dot while
 * it runs, a muted check once done, a red × if it failed. It stays in view
 * when the icon slot turns into the close ×. A change fades in place
 * (swap-motion is opacity only, and off under reduced motion).
 */
function Status({ status, className }: { status: PanelTabStatus | null; className?: string }) {
  if (status === null) return null;
  return (
    <span
      key={status}
      aria-hidden
      data-slot="panel-tab-status"
      data-status={status}
      className={cn("swap-motion flex size-4 shrink-0 items-center justify-center", className)}
    >
      {status === "running" ? (
        <span className="size-1.5 rounded-full bg-success" />
      ) : status === "done" ? (
        <Check className="size-3 text-muted-foreground/70" />
      ) : (
        <X className="size-3 text-destructive-foreground" />
      )}
    </span>
  );
}

export const PanelTab = { Body, Icon, Label, Status, Action };

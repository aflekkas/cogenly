import { Check, X } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

import type { PanelTabStatus } from "./TabStrip.logic";

/**
 * The look of a closable tab in a TabStrip (the right panel's browser, file
 * and device tabs, the bottom drawer's agent tabs): compact and as wide as
 * its title, text first, the selected one a quiet fill, and its × showing on
 * hover and, dimmed, on the selected tab. Hover and selection fade on the fast token;
 * colour changes are opacity-free, so reduced motion needs nothing more.
 *
 * Slots carry the styling; TabStrip owns behaviour (roles, focus, drag,
 * overflow, close) and places them. Layout classes go through `className`.
 */
function Body({ active, className, ...props }: ComponentProps<"div"> & { active: boolean }) {
  return (
    <div
      data-slot="panel-tab"
      data-active={active ? "" : undefined}
      className={cn(
        "group/panel-tab flex h-7 min-w-0 items-center gap-1.5 rounded-md ps-2 pe-1 text-xs transition-colors duration-(--motion-duration-fast) ease-out",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** The tab's icon or favicon, at the strip's small size. */
function Icon({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="panel-tab-icon"
      className={cn("relative flex size-3.5 shrink-0 items-center justify-center", className)}
      {...props}
    />
  );
}

/** The title; it truncates at the tab's maximum width. */
function Label({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="panel-tab-label"
      className={cn("min-w-0 flex-1 truncate text-left", className)}
      {...props}
    />
  );
}

const ACTION_CLASS =
  "flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm outline-none transition-[opacity,background-color,color] duration-(--motion-duration-fast) ease-out hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/** A small icon button that stays in view, such as a tab's mute toggle. */
function Action({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-slot="panel-tab-action"
      className={cn(ACTION_CLASS, className)}
      {...props}
    />
  );
}

/** Its ×: hidden at rest, shown on hover or keyboard focus, dimmed on the selected tab. */
function Close({ active, className, ...props }: ComponentProps<"button"> & { active: boolean }) {
  return (
    <button
      type="button"
      data-slot="panel-tab-close"
      className={cn(
        ACTION_CLASS,
        "text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover/panel-tab:opacity-100",
        active && "opacity-60",
        className,
      )}
      {...props}
    >
      <X className="size-3" />
    </button>
  );
}

/**
 * What the work behind the tab is doing, after its title: a small dot while
 * it runs, a muted check once done, a red × if it failed. A change fades in
 * place (swap-motion is opacity only, and off under reduced motion).
 */
function Status({ status, className }: { status: PanelTabStatus | null; className?: string }) {
  if (status === null) return null;
  return (
    <span
      key={status}
      aria-hidden
      data-slot="panel-tab-status"
      data-status={status}
      className={cn("swap-motion flex size-3.5 shrink-0 items-center justify-center", className)}
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

export const PanelTab = { Body, Icon, Label, Status, Action, Close };

import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/** One glass backdrop until a top attachment needs the composer to cover its overlap. */
// Registered so the strip's extension can animate: the card's fill ends that far above
// the shell's bottom, so its edge follows the tray as it grows and collapses.
if (typeof CSS !== "undefined" && "registerProperty" in CSS) {
  try {
    CSS.registerProperty({
      name: "--chat-composer-context-extension",
      syntax: "<length>",
      inherits: true,
      initialValue: "0px",
    });
  } catch {
    // Already registered (hot reload).
  }
}

function Shell({
  contextStrip = false,
  contextStripCollapsed = false,
  className,
  ...props
}: ComponentProps<"div"> & { contextStrip?: boolean; contextStripCollapsed?: boolean }) {
  return (
    <div
      data-slot="composer-shell"
      data-with-context={contextStrip || undefined}
      data-context-collapsed={contextStripCollapsed || undefined}
      className={cn(
        "@container/composer-surface group/composer-surface relative isolate mx-auto w-full max-w-(--chat-content-max-width)",
        "[--chat-composer-drawer-inset:1.375rem] [--chat-composer-glass-surface:var(--message-surface)] [--chat-composer-outline:rgb(0_0_0/8%)]",
        "dark:[--chat-composer-glass-surface:var(--message-surface)] dark:[--surface-raised-shadow:var(--surface-halo,0_1px_2px_rgb(0_0_0/30%))] dark:[--corner-glow:4%] dark:[--corner-glow-top:2.8%] dark:[--surface-raised-sheen-top:transparent] dark:[--surface-raised-sheen-bottom:transparent] dark:[--chat-composer-highlight:transparent] dark:[--surface-raised-edge-top:var(--surface-edge,rgb(255_255_255/4%))] dark:[--surface-raised-edge-side:var(--surface-edge,rgb(255_255_255/4%))] dark:[--surface-raised-edge-bottom:var(--surface-edge,rgb(255_255_255/4%))] dark:[--chat-composer-outline:var(--surface-edge,rgb(255_255_255/4%))]",
        "[html[data-theme-id]_&]:[--chat-composer-glass-surface:var(--message-surface)] [html[data-theme-id]_&]:[--chat-composer-outline:var(--app-theme-toolbar-border)]",
        "dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-highlight:color-mix(in_srgb,var(--app-theme-input)_12%,transparent)] dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-outline:color-mix(in_srgb,var(--app-theme-input)_30%,var(--background))]",
        "dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-highlight:color-mix(in_srgb,#432d48_12%,transparent)] dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-outline:#241e28]",
        // The card's fill. A context strip is a tray tucked under the card, so the
        // fill stops at the card's bottom edge and the tray paints its own.
        "before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-3xl before:bg-linear-to-b before:from-(--surface-raised-sheen-top) before:to-(--surface-raised-sheen-bottom) before:bg-(--chat-composer-glass-surface)",
        "has-data-[composer-banner-surface=attached]:before:hidden data-model-strip-transition:before:hidden",
        contextStrip && [
          "[--chat-composer-context-extension:2.25rem] sm:[--chat-composer-context-extension:2rem]",
          "data-context-collapsed:[--chat-composer-context-extension:0px] sm:data-context-collapsed:[--chat-composer-context-extension:0px]",
          "motion-safe:transition-[--chat-composer-context-extension] motion-safe:duration-(--motion-duration-base) motion-safe:ease-standard",
          "before:bottom-(--chat-composer-context-extension)",
        ],
        className,
      )}
      {...props}
    />
  );
}

const outlineClasses =
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:surface-raised-edge dark:after:p-0.5!";

function Host({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-host"
      className={cn(
        // Measured on the reference composer: a few levels of rim on the top
        // and left, a one-pixel shade on the right and below, no bright ring.
        "relative z-10 w-full rounded-3xl shadow-(--surface-raised-shadow) after:z-1",
        outlineClasses,
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none group-has-data-[composer-banner-surface=attached]/composer-surface:after:hidden",
        className,
      )}
      {...props}
    />
  );
}

function Main({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-chat-composer-main-surface="true"
      className={cn(
        "group relative z-10 rounded-3xl p-px",
        // The host also wraps shoulder tabs, so its backdrop would extend above the input.
        "group-data-model-strip-transition/composer-surface:bg-(--chat-composer-glass-surface)",
        outlineClasses,
        "after:z-20 after:hidden group-has-data-[composer-banner-surface=attached]/composer-surface:after:block group-data-model-strip-transition/composer-surface:after:block",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-surface)",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-composer dark:group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:**:data-[chat-composer-mobile-collapsed=true]:min-h-[calc(1rem+1px)]",
        className,
      )}
      {...props}
    />
  );
}

function ContextStrip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-context-strip"
      className={cn(
        "group/composer-context relative isolate mx-auto -mt-4 flex w-[calc(100%-2*var(--chat-composer-drawer-inset))] items-center gap-2 overflow-x-clip overflow-y-visible px-2 pt-5 pb-1",
        // A tray tucked under the card: its top 1rem is behind the card, so the
        // fill, hairline and shadow start at the card's bottom edge, where the
        // tray's sides meet the card's own ring at the same weight and tone.
        "before:pointer-events-none before:absolute before:inset-x-0 before:top-4 before:bottom-0 before:-z-1 before:rounded-b-2xl before:border before:border-t-0 before:border-(--chat-composer-outline) before:bg-(--chat-composer-glass-surface) before:shadow-(--surface-raised-shadow)",
        "dark:before:border-x-2 dark:before:border-b-2 dark:before:bg-composer-seam-below",
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { Shell, Host, Main, ContextStrip };

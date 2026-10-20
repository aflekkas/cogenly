import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/** One glass backdrop until a top attachment needs the composer to cover its overlap. */
// Registered so the strip's extension can animate: the shell's silhouette is a function
// of it, and at zero it is the plain rounded box, so the corners follow the strip.
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
        "[--chat-composer-drawer-inset:1.375rem] [--chat-composer-glass-surface:var(--card)] [--chat-composer-outline:rgb(0_0_0/8%)]",
        "dark:[--chat-composer-glass-surface:var(--composer-surface,var(--surface-raised))] dark:[--corner-glow:2.5%] dark:[--surface-raised-sheen-top:transparent] dark:[--surface-raised-sheen-bottom:transparent] dark:[--chat-composer-highlight:transparent] dark:[--surface-raised-edge-top:rgb(255_255_255/1.2%)] dark:[--surface-raised-edge-side:rgb(255_255_255/1.2%)] dark:[--surface-raised-edge-bottom:rgb(255_255_255/1.2%)] dark:[--chat-composer-outline:var(--surface-edge,rgb(255_255_255/5%))]",
        "[html[data-theme-id]_&]:[--chat-composer-glass-surface:var(--app-theme-surface-raised)] [html[data-theme-id]_&]:[--chat-composer-outline:var(--app-theme-toolbar-border)]",
        "dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-highlight:color-mix(in_srgb,var(--app-theme-input)_12%,transparent)] dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-outline:color-mix(in_srgb,var(--app-theme-input)_30%,var(--background))]",
        "dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-highlight:color-mix(in_srgb,#432d48_12%,transparent)] dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-outline:#241e28]",
        "before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-3xl before:bg-linear-to-b before:from-(--surface-raised-sheen-top) before:to-(--surface-raised-sheen-bottom) before:bg-(--chat-composer-glass-surface)",
        "has-data-[composer-banner-surface=attached]:before:hidden data-model-strip-transition:before:hidden",
        contextStrip && [
          "[--chat-composer-context-extension:2.25rem] sm:[--chat-composer-context-extension:2rem]",
          "data-context-collapsed:[--chat-composer-context-extension:0px] sm:data-context-collapsed:[--chat-composer-context-extension:0px]",
          "motion-safe:transition-[--chat-composer-context-extension] motion-safe:duration-(--motion-duration-base) motion-safe:ease-standard",
          // Keep one continuous backdrop around the fixed-pixel corners and rem-sized strip inset.
          "supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:rounded-none",
          "before:[clip-path:shape(from_0_22px,curve_to_22px_0_with_0_9.85px/9.85px_0,line_to_calc(100%-22px)_0,curve_to_100%_22px_with_calc(100%-9.85px)_0/100%_9.85px,line_to_100%_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset)),curve_to_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-var(--chat-composer-context-extension))_with_100%_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset)*0.4477)/calc(100%-var(--chat-composer-drawer-inset)*0.4477)_calc(100%-var(--chat-composer-context-extension)),line_to_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-16px),curve_to_calc(100%-var(--chat-composer-drawer-inset)-16px)_100%_with_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-7.16px)/calc(100%-var(--chat-composer-drawer-inset)-7.16px)_100%,line_to_calc(var(--chat-composer-drawer-inset)+16px)_100%,curve_to_var(--chat-composer-drawer-inset)_calc(100%-16px)_with_calc(var(--chat-composer-drawer-inset)+7.16px)_100%/var(--chat-composer-drawer-inset)_calc(100%-7.16px),line_to_var(--chat-composer-drawer-inset)_calc(100%-var(--chat-composer-context-extension)),curve_to_0_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset))_with_calc(var(--chat-composer-drawer-inset)*0.4477)_calc(100%-var(--chat-composer-context-extension))/0_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset)*0.4477),line_to_0_22px,close)]",
          "not-supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:bottom-(--chat-composer-context-extension)",
        ],
        className,
      )}
      {...props}
    />
  );
}

const outlineClasses =
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:surface-raised-edge dark:after:p-0.5!";

// The bottom strip continues the outline, so leave the seam between its corners open.
const contextSeamClasses =
  "group-data-with-context/composer-surface:after:[clip-path:polygon(0_0,100%_0,100%_100%,calc(100%-22px)_100%,calc(100%-22px)_calc(100%-2px),22px_calc(100%-2px),22px_100%,0_100%)]";

function Host({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-host"
      className={cn(
        // Measured on the reference composer: a few levels of rim on the top
        // and left, a one-pixel shade on the right and below, no bright ring.
        "relative z-10 w-full rounded-3xl shadow-(--surface-raised-shadow) after:z-1 dark:[--surface-raised-shadow:0_1px_1px_rgb(0_0_0/30%),0_10px_28px_-14px_rgb(0_0_0/50%)]",
        outlineClasses,
        contextSeamClasses,
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
        contextSeamClasses,
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
        "before:absolute before:inset-0 before:-z-1 before:rounded-b-2xl before:border before:border-(--chat-composer-outline) before:mask-b-from-transparent before:mask-b-from-4 before:mask-b-to-black before:mask-b-to-4 before:shadow-composer",
        "dark:before:border-transparent dark:before:bg-composer-seam-below dark:before:shadow-composer-dark",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:before:bg-(--chat-composer-glass-surface)",
        "not-supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:bg-(--chat-composer-glass-surface)",
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { Shell, Host, Main, ContextStrip };

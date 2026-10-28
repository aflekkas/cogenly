"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

// One disabled look for the bordered variants (default, outline): no fill, a
// muted label and the resting border, instead of fading. Faded, a disabled
// primary reads as a grey slab and a disabled outline as enabled. A button
// disabled only while its own request runs (aria-busy) keeps its look and
// dims, so a pending submit doesn't flip to an outline and back. The base's
// `interactive` transition fades between the states.
const DISABLED_SURFACE =
  "not-aria-busy:disabled:border-border not-aria-busy:disabled:bg-transparent dark:not-aria-busy:disabled:bg-transparent not-aria-busy:disabled:text-muted-foreground not-aria-busy:disabled:[--control-icon-color:currentColor] not-aria-busy:aria-disabled:border-border not-aria-busy:aria-disabled:bg-transparent dark:not-aria-busy:aria-disabled:bg-transparent not-aria-busy:aria-disabled:text-muted-foreground not-aria-busy:aria-disabled:shadow-none not-aria-busy:aria-disabled:[--control-icon-color:currentColor] aria-busy:disabled:opacity-64 aria-busy:aria-disabled:opacity-64";

// Every other variant fades when disabled. A compound variant rather than a
// base rule keyed on data-variant, so buttonVariants() outside Button (toast
// and menu actions) gets exactly one disabled treatment.
const FADED_DISABLED_VARIANTS = [
  "brand",
  "destructive",
  "destructive-outline",
  "ghost",
  "ghost-muted",
  "ghost-destructive",
  "glass",
  "link",
  "media-close",
  "media-solid",
  "media-navigation",
  "overlay",
  "secondary",
  "warning-outline",
] as const;

const buttonVariants = cva(
  "[--control-icon-color:currentColor] [&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border font-medium text-base outline-none interactive [&:not([aria-haspopup]):not(:disabled):not([aria-disabled=true])]:will-change-[scale] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none aria-disabled:cursor-not-allowed sm:text-sm [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    compoundVariants: [
      {
        variant: [...FADED_DISABLED_VARIANTS],
        className: "disabled:opacity-64 aria-disabled:opacity-64",
      },
    ],
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      // Sizes below 32px step --control-radius down with their height (see
      // the --control-radius-* tokens), which the border and inner ring share.
      size: {
        compact:
          "[--control-radius:var(--control-radius-sm)] h-7 gap-1 px-[calc(--spacing(2)-1px)] text-xs [&_svg:not([class*='size-'])]:size-3.5",
        default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8",
        icon: "size-9 sm:size-8",
        "icon-lg": "size-10 sm:size-9",
        "icon-micro":
          "[--control-radius:var(--control-radius-2xs)] size-5 p-0 [&_svg:not([class*='size-'])]:size-3",
        "icon-tiny":
          "[--control-radius:var(--control-radius-2xs)] size-4 p-0 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "[--control-radius:var(--control-radius-sm)] size-8 sm:size-7",
        "icon-xl":
          "size-11 sm:size-10 [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        "icon-xs":
          "[--control-radius:var(--control-radius-xs)] size-7 sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
        // A shortcut's keycaps as a button (the key recorder): row height, with the
        // keycaps nearly flush so their edge is the control's edge.
        keys: "[--control-radius:var(--control-radius-xs)] h-8 gap-1 px-px sm:h-7",
        lg: "h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9",
        // A quiet control set in a row's metadata line (a keybinding's when
        // clause): micro's height at the 12px, normal-weight meta scale.
        meta: "[--control-radius:var(--control-radius-2xs)] h-5 gap-1 px-[calc(--spacing(1.5)-1px)] text-xs font-normal sm:text-xs [&_svg:not([class*='size-'])]:size-3 sm:[&_svg:not([class*='size-'])]:size-3",
        micro:
          "[--control-radius:var(--control-radius-2xs)] h-5 gap-1 px-[calc(--spacing(1.5)-1px)] text-[11px] sm:text-[11px] [&_svg:not([class*='size-'])]:size-3 sm:[&_svg:not([class*='size-'])]:size-3",
        sm: "[--control-radius:var(--control-radius-sm)] h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:h-7",
        "sm-multiline":
          "[--control-radius:var(--control-radius-sm)] min-h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] py-[calc(--spacing(1)-1px)] whitespace-normal sm:min-h-7",
        xl: "h-11 px-[calc(--spacing(4)-1px)] text-lg sm:h-10 sm:text-base [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        xs: "[--control-radius:var(--control-radius-xs)] h-7 gap-1 px-[calc(--spacing(2)-1px)] text-sm sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        // The brand orange, reserved for first-run empty-state hero CTAs that
        // start something new (first agent, first project, first repository).
        // Everything else is the neutral default. The label is semibold so the
        // white-on-ember contrast (3.2:1 at the top of the gradient, 4.1:1 at
        // the bottom in dark; 4.7:1 in light) holds as large-text.
        brand:
          "border-transparent bg-linear-to-b from-brand-cta-top to-brand-cta-bottom font-semibold text-white shadow-black/24 shadow-xs not-disabled:inset-shadow-[0_1px_--theme(--color-white/22%)] [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/12%)] [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:from-brand-cta-top-hover [:hover,[data-pressed]]:to-brand-cta-bottom-hover [&_svg]:text-white",
        default:
          DISABLED_SURFACE +
          " not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-primary bg-primary text-primary-foreground shadow-primary/24 shadow-xs [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:bg-primary/90",
        destructive:
          "not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-destructive bg-destructive text-white shadow-destructive/24 shadow-xs [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:bg-destructive/90",
        "destructive-outline":
          "border-input bg-popover not-dark:bg-clip-padding text-destructive-foreground shadow-xs/5 not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:bg-input/32 dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:border-destructive/32 [:hover,[data-pressed]]:bg-destructive/4",
        ghost:
          "[--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-foreground state-hover data-pressed:state-selected",
        "ghost-muted":
          "[--control-icon-color:currentColor] border-transparent text-muted-foreground state-hover data-pressed:state-selected",
        "ghost-destructive":
          "[--control-icon-color:currentColor] border-transparent text-muted-foreground [--state-hover-foreground:var(--color-destructive)] [--state-selected-foreground:var(--color-destructive)] state-hover data-pressed:state-selected",
        glass:
          "surface-glass [--control-icon-color:var(--contrast-muted-foreground)] rounded-full border-border/60 text-foreground shadow-sm before:rounded-full [:hover,[data-pressed]]:border-border",
        link: "border-transparent link",
        "media-close":
          "[--control-icon-color:currentColor] border-transparent bg-black/65 text-white shadow-sm ring-1 ring-white/20 [:hover,[data-pressed]]:bg-black/80 focus-visible:ring-white",
        // An opaque control over live content, such as the browser mini preview's
        // close: nothing behind it shows through.
        "media-solid":
          "[--control-icon-color:currentColor] border-border bg-popover text-popover-foreground shadow-sm [:hover,[data-pressed]]:bg-[color-mix(in_srgb,var(--popover),var(--foreground)_8%)]",
        "media-navigation":
          "[--control-icon-color:currentColor] absolute top-1/2 z-20 -translate-y-1/2 border-transparent text-white/90 [:hover,[data-pressed]]:bg-white/10 [:hover,[data-pressed]]:text-white focus-visible:ring-white focus-visible:ring-offset-transparent",
        outline:
          DISABLED_SURFACE +
          " [--control-icon-color:var(--contrast-muted-foreground)] border-input bg-popover not-dark:bg-clip-padding text-foreground shadow-xs/5 not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:bg-input/32 dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:bg-accent/50 dark:[:hover,[data-pressed]]:bg-input/64",
        overlay: "border-transparent bg-black/70 text-white/65 [:hover,[data-pressed]]:bg-black/90",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [:active,[data-pressed]]:bg-secondary/80 [:hover,[data-pressed]]:bg-secondary/90",
        "warning-outline":
          "border-warning/32 bg-warning-surface text-warning-foreground shadow-xs/5 [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:border-warning/40 [:hover,[data-pressed]]:bg-warning/16 dark:[:hover,[data-pressed]]:bg-warning/24",
      },
    },
  },
);

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

function Button({ className, variant, size, render, ...props }: ButtonProps) {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] = render
    ? undefined
    : "button";

  const defaultProps = {
    className: cn(buttonVariants({ className, size, variant })),
    "data-slot": "button",
    "data-size": size ?? "default",
    "data-variant": variant ?? "default",
    type: typeValue,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

// buttonVariants is exported for other components/ui modules only; app code
// renders a Button (with `render` for other elements) instead.
export { Button, buttonVariants, type ButtonSize, type ButtonVariant };

const inlineButtonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center gap-0.5 underline-offset-2 interactive [text-align:var(--inline-button-text-align,center)] [white-space:var(--inline-button-white-space,nowrap)] hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64",
  {
    defaultVariants: { tone: "default", weight: "medium" },
    variants: {
      weight: {
        normal: "font-normal",
        medium: "font-medium",
      },
      tone: {
        default: "text-foreground",
        muted: "text-muted-foreground hover:text-foreground",
        destructive: "text-destructive/80 hover:text-destructive",
        /** Opens a menu from inside a sentence; the quiet underline marks it as a choice. */
        picker:
          "group/inline-button gap-1.5 text-foreground underline decoration-foreground/30 decoration-from-font underline-offset-4 hover:decoration-foreground focus-visible:decoration-foreground data-popup-open:decoration-foreground",
      },
    },
  },
);

/** An inline text action. Set --inline-button-white-space to normal in wrapping prose containers. */
export function InlineButton({
  className,
  tone,
  weight,
  render,
  ...props
}: useRender.ComponentProps<"button"> & VariantProps<typeof inlineButtonVariants>) {
  const defaultProps = {
    className: cn(inlineButtonVariants({ tone, weight }), className),
    "data-slot": "inline-button",
    type: render ? undefined : ("button" as const),
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

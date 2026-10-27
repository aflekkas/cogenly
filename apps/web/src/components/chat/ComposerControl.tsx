import { mergeProps } from "@base-ui/react/merge-props";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { useRender } from "@base-ui/react/use-render";
import type { ComponentProps, ComponentType, SVGProps } from "react";
import { ChevronDownIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Separator } from "../ui/separator";

export type ComposerControlSize = "sm" | "xs";

/**
 * The icon → label → chevron gap. Pickers that wrap their content in an inner row (the model
 * picker's tooltip span, the Codex effort label) use it too, so every control reads the same.
 */
export function composerControlGapClassName(size: ComposerControlSize) {
  return size === "xs" ? "gap-1" : "gap-1.5";
}

/**
 * The composer toolbar's control look. `sm` is the expanded toolbar; `xs` is the dimmer resting
 * strip. `aria-pressed` marks a toggle that is on (plan mode). This is an app control, not a
 * restyled Button, so it owns its classes.
 */
function composerControlClassName(size: ComposerControlSize, className?: string) {
  return cn(
    "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-(--control-radius) border border-transparent text-base outline-none interactive state-hover data-pressed:state-selected focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-disabled:pointer-events-none data-disabled:opacity-64 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:-mx-0.5 [&_svg[data-composer-control-icon]]:mx-0",
    composerControlGapClassName(size),
    // A narrow glyph (the plug) has twice the side bearing of the rest of the set; pulling its
    // box in keeps its ink as far from the label and the previous control as theirs.
    size === "xs"
      ? "h-7 px-1.75 font-normal text-muted-foreground text-sm hover:text-foreground/80 sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5 [&_svg[data-composer-control-chevron]]:-ms-0.5 [&_svg[data-composer-control-chevron]]:-me-1 [&_svg[data-composer-control-icon=narrow]]:-mx-0.5!"
      : "h-7 px-2.5 font-medium text-secondary-label [&_svg:not([class*='text-'])]:text-muted-foreground hover:text-foreground sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg[data-composer-control-icon=narrow]]:-mx-0.75!",
    "aria-pressed:state-selected",
    className,
  );
}

/**
 * A control that gives way first in a narrow composer: it takes nearly all of the
 * row's shrink, its label truncating away, so it reaches its icon and chevron before
 * the model and effort pickers start truncating theirs. The aria-label keeps the
 * full name. The label is a one-column grid whose track can reach zero, so a nowrap
 * label no longer holds the control at its full width: its floor is the icon and
 * chevron. Its text goes in a child, which truncates.
 */
const COLLAPSIBLE_CLASS_NAME =
  "shrink-[100] [&_[data-composer-control-label]]:grid [&_[data-composer-control-label]]:grid-cols-[minmax(0,max-content)] [&_[data-composer-control-label]>*]:truncate";

type ComposerControlProps = useRender.ComponentProps<"button"> & {
  size?: ComposerControlSize;
  collapsible?: boolean;
};

export function ComposerControl({
  className,
  size = "sm",
  collapsible = false,
  render,
  ...props
}: ComposerControlProps) {
  const defaultProps = {
    className: composerControlClassName(size, cn(collapsible && COLLAPSIBLE_CLASS_NAME, className)),
    type: render ? undefined : ("button" as const),
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export function ComposerControlIcon({
  icon: Icon,
  className,
  opticalSize = "default",
  opticalWidth = "default",
  size = "sm",
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  className?: string | undefined;
  opticalSize?: "default" | "large";
  /** `narrow` for a glyph whose ink is much thinner than its box, such as the plug. */
  opticalWidth?: "default" | "narrow";
  size?: ComposerControlSize;
}) {
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        "shrink-0",
        size === "xs" ? "size-3" : opticalSize === "large" ? "size-4.5" : "size-4",
        className,
      )}
      data-composer-control-icon={opticalWidth === "narrow" ? "narrow" : ""}
    />
  );
}

export function ComposerControlChevron({
  className,
  size = "sm",
}: {
  className?: string;
  size?: ComposerControlSize;
} = {}) {
  return (
    <ChevronDownIcon
      aria-hidden="true"
      className={cn(
        "shrink-0",
        size === "xs" ? "size-3 text-current opacity-50" : "size-3.5 text-icon-muted",
        className,
      )}
      data-composer-control-chevron
      strokeWidth={2.25}
    />
  );
}

export function ComposerControlSeparator({
  className,
  size = "sm",
  ...props
}: Omit<ComponentProps<typeof Separator>, "orientation"> & {
  size?: ComposerControlSize;
}) {
  return (
    <Separator
      orientation="vertical"
      className={cn("mx-1 hidden sm:block", size === "xs" ? "h-3.5!" : "h-4", className)}
      {...props}
    />
  );
}

export function ComposerSelectControl({
  className,
  children,
  size = "sm",
  ...props
}: Omit<SelectPrimitive.Trigger.Props, "className"> & {
  className?: string | undefined;
  size?: ComposerControlSize;
}) {
  return (
    <SelectPrimitive.Trigger className={composerControlClassName(size, className)} {...props}>
      {children}
      <SelectPrimitive.Icon>
        <ComposerControlChevron size={size} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

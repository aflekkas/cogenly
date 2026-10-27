"use client";

import { SearchIcon, XIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "~/lib/utils";

import { Button } from "./button";
import { Kbd } from "./kbd";

/**
 * The look of every search field: a leading search icon, the query, and on the right a clear
 * button once there is text, else an optional shortcut hint, then any actions. It is the sidebar's
 * search dock, made general.
 *
 * - `SearchField` is the frame. Pass the input as its child when the input must be another
 *   component (a Base UI combobox or autocomplete input): give that input
 *   `searchFieldInputClassName`.
 * - `SearchInput` is the frame with a native input, for everything else.
 * - `variant="field"` draws the frame. `variant="bare"` draws none, for a palette or popup header
 *   whose container already is the frame.
 */
const searchFieldVariants = {
  field:
    "corner-glow relative rounded-rail border border-(--surface-edge,rgb(255_255_255/6%)) bg-(--sidebar-input-surface,var(--message-surface)) shadow-(--surface-halo,none) [--corner-glow-top:1%] [--corner-glow:1%] transition-colors focus-within:border-foreground/25",
  bare: "relative",
} as const;

// sm 32px, md 36px (the sidebar dock, level with its count bar), lg 44px (palette headers).
const searchFieldSizeClassName = {
  sm: "h-8 gap-2 text-sm",
  md: "h-9 gap-2 text-sm",
  lg: "h-11 gap-2 text-sm",
} as const;

// Frame padding leaves room on the right for the trailing controls, which carry their own inset.
const searchFieldPaddingClassName = {
  field: { sm: "pr-1 pl-2.5", md: "pr-1 pl-2.5", lg: "pr-1 pl-2.5" },
  bare: { sm: "px-0", md: "px-0", lg: "px-0" },
} as const;

// Opacity only, so the trailing controls appear and leave in place (kept under reduced motion).
const trailingFadeClassName = "transition-opacity duration-(--motion-duration-fast) ease-out";

/** For an input placed inside a `SearchField`; `SearchInput` applies it itself. */
const searchFieldInputClassName =
  "h-full min-w-0 flex-1 bg-transparent p-0 font-medium text-foreground leading-normal outline-none placeholder:text-(--sidebar-input-placeholder,var(--placeholder)) [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none";

interface SearchFieldProps extends React.ComponentProps<"div"> {
  size?: keyof typeof searchFieldSizeClassName;
  variant?: keyof typeof searchFieldVariants;
  /** Whether the query has text; shows the clear button instead of the shortcut hint. */
  hasValue?: boolean;
  /** Clears the query. The clear button shows while `hasValue`. */
  onClear?: () => void;
  clearLabel?: string;
  /** A shortcut hint shown while the field is empty, such as `/`. */
  shortcut?: React.ReactNode;
  /** Controls after the field's own, such as filter and new buttons. */
  actions?: React.ReactNode;
  /** Replaces the search icon, for a field that also says where it searches or lets you go back. */
  icon?: React.ReactNode;
  /** Sits between the icon and the query, such as a chip naming a filter the search composes with. */
  leading?: React.ReactNode;
}

function SearchField({
  size = "sm",
  variant = "field",
  hasValue = false,
  onClear,
  clearLabel = "Clear search",
  shortcut,
  actions,
  icon,
  leading,
  className,
  children,
  ...props
}: SearchFieldProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center",
        searchFieldVariants[variant],
        searchFieldSizeClassName[size],
        searchFieldPaddingClassName[variant][size],
        className,
      )}
      data-size={size}
      data-slot="search-field"
      data-variant={variant}
      {...props}
    >
      {icon ?? (
        <SearchIcon
          aria-hidden
          className="size-4 shrink-0 text-(--sidebar-icon-color,var(--icon-muted))"
        />
      )}
      {leading}
      {children}
      {/* The clear button is a 28px tile like the actions after it, in the same gapless row, so
          it keeps their rhythm. Its slot is always reserved and the clear button and shortcut
          hint share it, crossfading, so typing never shifts the actions. */}
      {onClear || shortcut || actions ? (
        <div className="flex shrink-0 items-center">
          {onClear || shortcut ? (
            <div className="grid shrink-0 place-items-center *:col-start-1 *:row-start-1">
              {shortcut ? (
                <Kbd
                  aria-hidden={hasValue || undefined}
                  className={cn(trailingFadeClassName, hasValue && "opacity-0")}
                >
                  {shortcut}
                </Kbd>
              ) : null}
              {onClear ? (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost-muted"
                  // Button already transitions opacity; only its timing is set here.
                  className={cn(
                    "duration-(--motion-duration-fast) ease-out",
                    !hasValue && "pointer-events-none opacity-0",
                  )}
                  aria-label={clearLabel}
                  inert={!hasValue || undefined}
                  onClick={onClear}
                >
                  <XIcon className="size-3.5" />
                </Button>
              ) : null}
            </div>
          ) : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}

type SearchInputProps = Omit<React.ComponentProps<"input">, "size" | "type"> &
  Pick<
    SearchFieldProps,
    "size" | "variant" | "onClear" | "clearLabel" | "shortcut" | "actions" | "leading"
  > & {
    /** Classes for the frame, for layout. */
    frameClassName?: string;
    ref?: React.Ref<HTMLInputElement>;
  };

function SearchInput({
  size,
  variant,
  onClear,
  clearLabel,
  shortcut,
  actions,
  leading,
  frameClassName,
  className,
  value,
  ref,
  ...props
}: SearchInputProps) {
  const hasValue = typeof value === "string" ? value.length > 0 : false;
  return (
    <SearchField
      {...(size ? { size } : {})}
      {...(variant ? { variant } : {})}
      hasValue={hasValue}
      {...(onClear ? { onClear } : {})}
      {...(clearLabel ? { clearLabel } : {})}
      {...(shortcut ? { shortcut } : {})}
      {...(actions ? { actions } : {})}
      {...(leading ? { leading } : {})}
      {...(frameClassName ? { className: frameClassName } : {})}
    >
      <input
        ref={ref}
        type="search"
        data-slot="search-input"
        value={value}
        className={cn(searchFieldInputClassName, className)}
        {...props}
      />
    </SearchField>
  );
}

export { SearchField, SearchInput, searchFieldInputClassName };
export type { SearchFieldProps, SearchInputProps };

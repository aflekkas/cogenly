"use client";

import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { ChevronRightIcon, ChevronsUpDownIcon, XIcon } from "lucide-react";
import * as React from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { searchFieldInputClassName } from "~/components/ui/search-input";
import {
  SEARCH_LIST_GROUP_LABEL_CLASS,
  SearchListGroupLabelContent,
  SearchListRowIcon,
  SearchListSearch,
  searchListEmptyVariants,
  searchListListVariants,
  searchListRowVariants,
} from "~/components/ui/search-list";

const ComboboxContext = React.createContext<{
  chipsRef: React.RefObject<Element | null> | null;
  multiple: boolean;
}>({
  chipsRef: null,
  multiple: false,
});

function Combobox<Value, Multiple extends boolean | undefined = false>(
  props: ComboboxPrimitive.Root.Props<Value, Multiple>,
) {
  const chipsRef = React.useRef<Element | null>(null);
  const value = React.useMemo(() => ({ chipsRef, multiple: !!props.multiple }), [props.multiple]);
  return (
    <ComboboxContext value={value}>
      <ComboboxPrimitive.Root {...props} />
    </ComboboxContext>
  );
}

function ComboboxInput({
  className,
  showTrigger = true,
  showClear = false,
  startAddon,
  size,
  unstyled = false,
  ...props
}: Omit<ComboboxPrimitive.Input.Props, "size"> & {
  showTrigger?: boolean;
  showClear?: boolean;
  startAddon?: React.ReactNode;
  size?: "sm" | "default" | "lg" | number;
  unstyled?: boolean;
  ref?: React.Ref<HTMLInputElement>;
}) {
  const sizeValue = (size ?? "default") as "sm" | "default" | "lg" | number;

  return (
    <div className="relative not-has-[>*.w-full]:w-fit w-full text-foreground has-disabled:opacity-64">
      {startAddon && (
        <div
          aria-hidden="true"
          className="[&_svg]:-mx-0.5 pointer-events-none absolute inset-y-0 start-px z-10 flex items-center ps-[calc(--spacing(3)-1px)] opacity-80 has-[+[data-size=sm]]:ps-[calc(--spacing(2.5)-1px)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4"
          data-slot="combobox-start-addon"
        >
          {startAddon}
        </div>
      )}
      <ComboboxPrimitive.Input
        className={cn(
          startAddon &&
            "data-[size=sm]:*:data-[slot=combobox-input]:ps-[calc(--spacing(7.5)-1px)] *:data-[slot=combobox-input]:ps-[calc(--spacing(8.5)-1px)] sm:data-[size=sm]:*:data-[slot=combobox-input]:ps-[calc(--spacing(7)-1px)] sm:*:data-[slot=combobox-input]:ps-[calc(--spacing(8)-1px)]",
          sizeValue === "sm"
            ? "has-[+[data-slot=combobox-trigger],+[data-slot=combobox-clear]]:*:data-[slot=combobox-input]:pe-6.5"
            : "has-[+[data-slot=combobox-trigger],+[data-slot=combobox-clear]]:*:data-[slot=combobox-input]:pe-7",
          className,
        )}
        data-slot="combobox-input"
        render={
          <Input
            className={cn(
              "has-disabled:opacity-100",
              unstyled && "rounded-none bg-transparent text-sm",
            )}
            nativeInput
            size={sizeValue}
            unstyled={unstyled}
          />
        }
        {...props}
      />
      {showTrigger && (
        <ComboboxTrigger
          className={cn(
            "-translate-y-1/2 absolute top-1/2 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 outline-none transition-opacity pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:opacity-100 has-[+[data-slot=combobox-clear]]:hidden sm:size-7 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
            sizeValue === "sm" ? "end-0" : "end-0.5",
          )}
        >
          <ComboboxPrimitive.Icon data-slot="combobox-icon">
            <ChevronsUpDownIcon />
          </ComboboxPrimitive.Icon>
        </ComboboxTrigger>
      )}
      {showClear && (
        <ComboboxClear
          className={cn(
            "-translate-y-1/2 absolute top-1/2 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 outline-none transition-opacity pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:opacity-100 has-[+[data-slot=combobox-clear]]:hidden sm:size-7 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
            sizeValue === "sm" ? "end-0" : "end-0.5",
          )}
        >
          <XIcon />
        </ComboboxClear>
      )}
    </div>
  );
}

/**
 * The search row at the top of a combobox popup: the shared search-list
 * header, borderless and flush with the popup with a hairline under it, so
 * there is no second radius to clash with the popup's.
 */
function ComboboxSearchInput({
  className,
  ...props
}: Omit<ComboboxPrimitive.Input.Props, "size" | "className"> & { className?: string }) {
  return (
    <SearchListSearch size="popover">
      <ComboboxPrimitive.Input
        data-slot="combobox-input"
        className={cn(searchFieldInputClassName, className)}
        {...props}
      />
    </SearchListSearch>
  );
}

function ComboboxTrigger({ className, children, ...props }: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger className={className} data-slot="combobox-trigger" {...props}>
      {children}
    </ComboboxPrimitive.Trigger>
  );
}

const POPUP_BODY_CLASS =
  "flex min-w-0 max-h-[min(var(--available-height),23rem)] flex-col overflow-hidden text-foreground";

/**
 * The popup body at its natural height, inside a shell that eases to that
 * height. The first measure lands before paint, so opening never animates;
 * reduced motion resizes at once.
 */
function ComboboxPopupHeight({ children }: { children: React.ReactNode }) {
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => setHeight(body.offsetHeight);
    measure();
    return observeResize(body, measure);
  }, []);
  return (
    <div
      className="min-w-0 flex-1 overflow-hidden transition-[height] duration-(--motion-duration-base) ease-standard motion-reduce:transition-none"
      style={height === null ? undefined : { height }}
      data-slot="combobox-popup-height"
    >
      <div ref={bodyRef} className={POPUP_BODY_CLASS}>
        {children}
      </div>
    </div>
  );
}

function ComboboxPopup({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  alignOffset,
  align = "start",
  // Keeps the popup clear of the viewport edge, so it never sits chopped
  // against a window side when its trigger is near one.
  collisionPadding = 12,
  anchor: anchorProp,
  animateHeight = false,
  ...props
}: ComboboxPrimitive.Popup.Props & {
  align?: ComboboxPrimitive.Positioner.Props["align"];
  sideOffset?: ComboboxPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: ComboboxPrimitive.Positioner.Props["alignOffset"];
  side?: ComboboxPrimitive.Positioner.Props["side"];
  collisionPadding?: ComboboxPrimitive.Positioner.Props["collisionPadding"];
  anchor?: ComboboxPrimitive.Positioner.Props["anchor"];
  /**
   * Glide to the new height when the rows change (a search narrowing the
   * list, results arriving) instead of snapping. For lists the popup owns;
   * a virtualized list sizes itself.
   */
  animateHeight?: boolean;
}) {
  const { chipsRef, multiple } = React.use(ComboboxContext);
  const anchor = anchorProp ?? (multiple ? chipsRef : undefined);

  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="z-[130] select-none"
        collisionPadding={collisionPadding}
        data-slot="combobox-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        {/* The Popup is the glass surface so its own transition drives open and close. */}
        <ComboboxPrimitive.Popup
          className={cn(
            "dropdown-glass surface-raised surface-raised-floating popup-motion relative flex max-h-full min-w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) rounded-lg transition-[opacity,scale,translate]",
            className,
          )}
          data-slot="combobox-popup"
          {...props}
        >
          {animateHeight ? (
            <ComboboxPopupHeight>{children}</ComboboxPopupHeight>
          ) : (
            <div className={cn(POPUP_BODY_CLASS, "flex-1")}>{children}</div>
          )}
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

/**
 * A picker row; build its content from the `SearchListRow*` slots. Its look
 * is `searchListRowVariants` (compact, with the chosen value painted selected).
 */
function ComboboxItem({
  className,
  children,
  hideIndicator: _hideIndicator = false,
  tone = "default",
  divider = false,
  ...props
}: ComboboxPrimitive.Item.Props & {
  hideIndicator?: boolean;
  /** `action` is for a row that does something other than pick a value, such as "Add repository": muted until hovered. */
  tone?: "default" | "action";
  /** Draws a hairline above the row, setting an action row apart from the values. */
  divider?: boolean;
}) {
  return (
    <ComboboxPrimitive.Item
      className={cn(
        searchListRowVariants({ density: "compact", highlight: "hover", tone, divider }),
        "in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      data-slot="combobox-item"
      {...props}
    >
      {/* Children lay out as one row: a label that truncates, then any trailing meta. */}
      <div className="flex min-w-0 flex-1 items-center gap-2" data-slot="combobox-item-content">
        {children}
      </div>
    </ComboboxPrimitive.Item>
  );
}

/** The shared row's leading column (`SearchListRowIcon`), under the name the pickers use. */
const ComboboxItemIcon = SearchListRowIcon;

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      className={cn(searchListEmptyVariants({ size: "popover" }), className)}
      data-slot="combobox-empty"
      {...props}
    />
  );
}

// The list pads 6px and rows pad 8px, so a highlighted row's fill sits 6px in
// from the popup edge and its icon 14px in, the same inset as the search row.
function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ScrollArea scrollbarGutter scrollFade>
      <ComboboxPrimitive.List
        className={cn(searchListListVariants({ size: "popover" }), className)}
        data-slot="combobox-list"
        {...props}
      />
    </ScrollArea>
  );
}

/**
 * A variant of `ComboboxList` without `ScrollArea`, for use when
 * an external virtualizer (e.g. LegendList) owns the scroll container.
 * It can hold focus itself; the highlighted item, not an outline, shows where it is.
 */
function ComboboxListVirtualized({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      className={cn("size-full min-w-0 outline-none not-empty:p-1.5", className)}
      data-slot="combobox-list"
      {...props}
    />
  );
}

function ComboboxClear({ className, ...props }: ComboboxPrimitive.Clear.Props) {
  return <ComboboxPrimitive.Clear className={className} data-slot="combobox-clear" {...props} />;
}

function ComboboxStatus({ className, ...props }: ComboboxPrimitive.Status.Props) {
  return (
    <ComboboxPrimitive.Status
      className={cn(
        "px-3 py-2 font-medium text-muted-foreground text-xs empty:m-0 empty:p-0",
        className,
      )}
      data-slot="combobox-status"
      {...props}
    />
  );
}

/** A titled run of rows; pass the group's `items` and render them through `ComboboxCollection`. */
function ComboboxGroup({ className, ...props }: ComboboxPrimitive.Group.Props) {
  return (
    <ComboboxPrimitive.Group
      className={cn("not-first:mt-2", className)}
      data-slot="combobox-group"
      {...props}
    />
  );
}

/**
 * A group's header: a quiet section line on the row-icon column, optionally
 * led by a mark (`icon`). Never filled, so it cannot read as a selected row.
 */
function ComboboxGroupLabel({
  className,
  icon,
  children,
  ...props
}: ComboboxPrimitive.GroupLabel.Props & { icon?: React.ReactNode }) {
  return (
    <ComboboxPrimitive.GroupLabel
      className={cn(SEARCH_LIST_GROUP_LABEL_CLASS, className)}
      data-slot="combobox-group-label"
      {...props}
    >
      <SearchListGroupLabelContent icon={icon}>{children}</SearchListGroupLabelContent>
    </ComboboxPrimitive.GroupLabel>
  );
}

const ComboboxCollection = ComboboxPrimitive.Collection;

/**
 * A collapsible group's header: a full-width button that names the group and
 * turns its chevron. A real button, so Tab reaches it from the search and
 * Enter or Space toggles it. Pair with `ComboboxGroupCollapse`.
 */
function ComboboxGroupToggle({
  open,
  icon,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"button">, "type"> & {
  open: boolean;
  /** The group's leading mark, on the row-icon column. */
  icon?: React.ReactNode;
}) {
  return (
    <ComboboxPrimitive.GroupLabel
      render={
        <button
          type="button"
          aria-expanded={open}
          className={cn(
            // A section label, not a row: no fill at rest or on hover, only
            // the text lifting a step and a ring for the keyboard.
            "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left font-medium text-muted-foreground text-xs outline-none transition-colors duration-(--motion-duration-fast) ease-standard hover:text-secondary-label focus-visible:text-secondary-label focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            className,
          )}
          {...props}
        />
      }
      data-slot="combobox-group-toggle"
    >
      {icon ? (
        <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "size-3 shrink-0 opacity-70 transition-[rotate] duration-(--motion-duration-base) ease-standard motion-reduce:transition-none",
          open && "rotate-90",
        )}
      />
    </ComboboxPrimitive.GroupLabel>
  );
}

/**
 * A group's rows, growing and fading open or shut while staying mounted, so
 * the list keeps its items and the popup's height follows the motion. Shut
 * rows go `invisible` once the motion ends, which takes them out of keyboard
 * navigation, and `inert`. Reduced motion keeps the fade only.
 */
function ComboboxGroupCollapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      inert={!open}
      className={cn(
        "grid transition-[grid-template-rows,opacity,visibility] duration-(--motion-duration-base) ease-standard motion-reduce:transition-[opacity,visibility]",
        open ? "visible grid-rows-[1fr] opacity-100" : "invisible grid-rows-[0fr] opacity-0",
      )}
      data-slot="combobox-group-collapse"
    >
      <div className="min-h-0 overflow-hidden">
        <ComboboxGroupItems afterHeader>{children}</ComboboxGroupItems>
      </div>
    </div>
  );
}

/**
 * A group's rows, 4px apart. `inset` tucks them in under their header so
 * the group they belong to reads at a glance; a flat list leaves it off.
 */
function ComboboxGroupItems({
  inset = true,
  afterHeader = false,
  children,
}: {
  inset?: boolean;
  /** Directly under a group header: a small gap keeps the first row off it. */
  afterHeader?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn("flex min-w-0 flex-col gap-1", inset && "ps-3", afterHeader && "pt-1")}
      data-slot="combobox-group-items"
    >
      {children}
    </div>
  );
}

const useComboboxFilter = ComboboxPrimitive.useFilter;

export {
  Combobox,
  ComboboxInput,
  ComboboxSearchInput,
  ComboboxTrigger,
  ComboboxPopup,
  ComboboxItem,
  ComboboxItemIcon,
  ComboboxEmpty,
  ComboboxList,
  ComboboxListVirtualized,
  ComboboxClear,
  ComboboxStatus,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxCollection,
  ComboboxGroupToggle,
  ComboboxGroupCollapse,
  ComboboxGroupItems,
  useComboboxFilter,
};

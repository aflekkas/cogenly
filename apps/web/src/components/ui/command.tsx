"use client";

import { Dialog as CommandDialogPrimitive } from "@base-ui/react/dialog";
import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import type * as React from "react";
import { cn } from "~/lib/utils";
import { OverlayPresenceBoundary, useOverlayPresenceRoot } from "~/components/ui/overlay-presence";
import {
  Autocomplete,
  AutocompleteCollection,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteItem,
  AutocompleteList,
  AutocompleteListHeading,
  AutocompleteListVirtualized,
} from "~/components/ui/autocomplete";
import { DIALOG_BACKDROP_CLASS, DIALOG_POPUP_CLASS } from "~/components/ui/dialog-styles";
import { Button } from "~/components/ui/button";
import { useAnimatedPanelHeight } from "~/components/ui/animated-panel-height";
import { searchFieldInputClassName } from "~/components/ui/search-input";
import { SearchListRowShortcut, SearchListSearch } from "~/components/ui/search-list";

/** Closes with its exit motion when an OverlayPresence around it empties. */
function CommandDialog<Payload>({
  open,
  onOpenChangeComplete,
  ...props
}: CommandDialogPrimitive.Root.Props<Payload>) {
  const presence = useOverlayPresenceRoot(open, onOpenChangeComplete);
  return (
    <OverlayPresenceBoundary>
      <CommandDialogPrimitive.Root
        {...props}
        open={presence.open}
        onOpenChangeComplete={presence.onOpenChangeComplete}
      />
    </OverlayPresenceBoundary>
  );
}

const CommandDialogPortal = CommandDialogPrimitive.Portal;

function CommandDialogTrigger(props: CommandDialogPrimitive.Trigger.Props) {
  return <CommandDialogPrimitive.Trigger data-slot="command-dialog-trigger" {...props} />;
}

function CommandDialogBackdrop({ className, ...props }: CommandDialogPrimitive.Backdrop.Props) {
  return (
    <CommandDialogPrimitive.Backdrop
      className={cn(DIALOG_BACKDROP_CLASS, className)}
      data-slot="command-dialog-backdrop"
      {...props}
    />
  );
}

function CommandDialogViewport({ className, ...props }: CommandDialogPrimitive.Viewport.Props) {
  return (
    <CommandDialogPrimitive.Viewport
      className={cn(
        "pointer-events-none fixed inset-0 z-50 flex flex-col items-center px-4 py-(--command-dialog-inset-y) [--command-dialog-inset-y:max(--spacing(4),4vh)] sm:[--command-dialog-inset-y:10vh]",
        className,
      )}
      data-slot="command-dialog-viewport"
      {...props}
    />
  );
}

/**
 * The palette glides to its content's new height as results change (useAnimatedPanelHeight).
 * `fullHeight` holds the tallest size instead, for a body that lays out its own fill; switching
 * between the two glides too.
 */
function CommandDialogPopup({
  className,
  children,
  onBackdropPointerDown,
  fullHeight = false,
  ...props
}: CommandDialogPrimitive.Popup.Props & {
  onBackdropPointerDown?: React.PointerEventHandler<HTMLDivElement>;
  fullHeight?: boolean;
}) {
  const { panelProps, contentRef } = useAnimatedPanelHeight();
  return (
    <CommandDialogPortal>
      <CommandDialogBackdrop onPointerDown={onBackdropPointerDown} />
      <CommandDialogViewport>
        <CommandDialogPrimitive.Popup
          className={cn(
            DIALOG_POPUP_CLASS,
            "pointer-events-auto max-w-xl text-foreground",
            className,
          )}
          data-slot="command-dialog-popup"
          {...props}
        >
          {/* The popup's own transitions are its fade and scale, so the height animates here. */}
          <div
            className="panel-height-motion shrink-0"
            data-slot="command-dialog-panel"
            {...panelProps}
          >
            <div
              ref={contentRef}
              className={cn(
                // 420px with the border, and never past the viewport's padding: the content
                // clamps itself, since the panel around it only follows its height.
                "flex min-h-0 flex-col [--command-dialog-max-height:min(--spacing(104.5),calc(100dvh-2*var(--command-dialog-inset-y)-2px))]",
                fullHeight
                  ? "h-(--command-dialog-max-height)"
                  : "max-h-(--command-dialog-max-height)",
              )}
            >
              {children}
            </div>
          </div>
        </CommandDialogPrimitive.Popup>
      </CommandDialogViewport>
    </CommandDialogPortal>
  );
}

function Command({
  autoHighlight = "always",
  keepHighlight = true,
  ...props
}: React.ComponentProps<typeof Autocomplete>) {
  return (
    <Autocomplete
      autoHighlight={autoHighlight}
      inline
      keepHighlight={keepHighlight}
      open
      {...props}
    />
  );
}

function CommandInput({
  className,
  placeholder,
  startAddon,
  ...props
}: Omit<AutocompletePrimitive.Input.Props, "size" | "className"> & {
  /** Classes for the field around the input (the palette adds end padding for its action label). */
  className?: string | undefined;
  /** Replaces the search icon, as the palette's submenu back button does. */
  startAddon?: React.ReactNode;
  ref?: React.Ref<HTMLInputElement>;
}) {
  return (
    <SearchListSearch size="dialog" icon={startAddon} className={className}>
      <AutocompletePrimitive.Input
        autoFocus
        className={cn(searchFieldInputClassName, "text-base")}
        data-slot="autocomplete-input"
        placeholder={placeholder}
        {...props}
      />
    </SearchListSearch>
  );
}

function CommandList(props: Omit<React.ComponentProps<typeof AutocompleteList>, "size">) {
  return <AutocompleteList size="dialog" data-slot="command-list" {...props} />;
}

// Pair with a LegendList child; the list owns scrolling and spacing.
function CommandListVirtualized({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteListVirtualized>) {
  return (
    <AutocompleteListVirtualized
      className={cn("flex max-h-[inherit] flex-col", className)}
      data-slot="command-list"
      {...props}
    />
  );
}

function CommandListHeading({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteListHeading>) {
  return (
    <AutocompleteListHeading className={className} data-slot="command-group-label" {...props} />
  );
}

function CommandPanel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative min-h-0 overflow-hidden rounded-t-xl not-has-[+[data-slot=command-footer]]:rounded-b-2xl bg-transparent **:data-[slot=scroll-area-scrollbar]:mt-2 [touch-action:pan-y]",
        className,
      )}
      {...props}
    />
  );
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof AutocompleteGroup>) {
  return <AutocompleteGroup className={className} data-slot="command-group" {...props} />;
}

function CommandGroupLabel({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteGroupLabel>) {
  return (
    <AutocompleteGroupLabel className={className} data-slot="command-group-label" {...props} />
  );
}

function CommandCollection({ ...props }: React.ComponentProps<typeof AutocompleteCollection>) {
  return <AutocompleteCollection data-slot="command-collection" {...props} />;
}

/**
 * A command row; build its content from the `SearchListRow*` slots. Pass `active` when the host
 * tracks the highlighted row itself; the primitive's hover and keyboard highlight are then ignored
 * so the two never disagree, and the row shows the active surface instead.
 */
function CommandItem({
  className,
  active,
  ...props
}: Omit<React.ComponentProps<typeof AutocompleteItem>, "highlight" | "density"> & {
  active?: boolean;
}) {
  return (
    <AutocompleteItem
      density="comfortable"
      // Nothing is chosen in a command list, so its cursor takes the selected fill.
      highlight={active === undefined ? "cursor" : "none"}
      className={cn(active && "state-selected", className)}
      data-active={active || undefined}
      data-slot="command-item"
      {...props}
    />
  );
}

const CommandShortcut = SearchListRowShortcut;

function CommandFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative flex items-center justify-between gap-2 rounded-b-[calc(var(--radius-2xl)-1px)] bg-foreground/[0.025] px-[var(--command-content-inset)] py-2.5 font-medium text-sm text-muted-foreground [&_[data-slot=kbd-group]]:font-sans [&_[data-slot=kbd]]:bg-foreground/[0.08] [&_[data-slot=kbd]]:text-foreground [&_[data-slot=kbd]]:ring-0",
        className,
      )}
      data-slot="command-footer"
      {...props}
    />
  );
}

function CommandFooterAction({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size" | "variant">) {
  return (
    <Button
      {...props}
      variant="ghost-muted"
      size="xs"
      className={cn("h-auto px-2 text-xs hover:bg-transparent", className)}
    />
  );
}

export {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTrigger,
  CommandFooter,
  CommandFooterAction,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandListHeading,
  CommandListVirtualized,
  CommandPanel,
  CommandShortcut,
};

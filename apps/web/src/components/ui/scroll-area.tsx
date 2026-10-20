"use client";

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";

import { cn } from "~/lib/utils";

function ScrollArea({
  className,
  children,
  scrollFade = true,
  scrollFadePadding = true,
  scrollbarGutter = false,
  hideScrollbars = false,
  chainVerticalScroll = false,
  radius = "inherit",
  viewportTabIndex,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  /** Edge fades where there is more to scroll (see scroll-fade in index.css). Off for
   * a viewport whose edges must stay crisp, like a canvas. */
  scrollFade?: boolean;
  /** Keep focused and highlighted items clear of the fade. Off for lists
   * whose rows take focus on click, where the scroll would nudge the list. */
  scrollFadePadding?: boolean;
  scrollbarGutter?: boolean;
  hideScrollbars?: boolean;
  chainVerticalScroll?: boolean;
  /** The viewport clips to the parent's radius; "none" for a region flush to an edge. */
  radius?: "inherit" | "none";
  /** Override Base UI's focusable viewport when focusable descendants provide scroll access. */
  viewportTabIndex?: number;
}) {
  const outOfTabOrder = viewportTabIndex !== undefined && viewportTabIndex < 0;
  return (
    <ScrollAreaPrimitive.Root
      className={cn(
        "relative size-full min-h-0 overflow-hidden",
        radius === "none" ? "rounded-none" : "rounded-[inherit]",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        {...(viewportTabIndex === undefined ? {} : { tabIndex: viewportTabIndex })}
        className={cn(
          "h-full max-h-[inherit] overflow-auto overscroll-contain rounded-[inherit] outline-none data-has-overflow-x:overscroll-x-contain",
          // Only a viewport that is a tab stop shows a focus ring. One taken out
          // of the tab order can still receive focus from a click or a closing
          // popup, and should not frame the whole region when it does.
          !outOfTabOrder &&
            "transition-shadow focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          chainVerticalScroll && "overscroll-y-auto",
          scrollFade && "scroll-fade",
          scrollFade && !outOfTabOrder && "focus-visible:mask-none",
          scrollFade && scrollFadePadding && "scroll-p-(--scroll-fade-size)",
          scrollFade && !scrollFadePadding && "has-focus-visible:mask-none",
          scrollbarGutter && "scrollbar-gutter-stable",
          hideScrollbars &&
            "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
        data-slot="scroll-area-viewport"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {!hideScrollbars && (
        <>
          <ScrollBar orientation="vertical" />
          <ScrollBar orientation="horizontal" />
          <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
        </>
      )}
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      className={cn(
        "flex opacity-0 transition-opacity delay-300 data-[orientation=horizontal]:mx-1 data-[orientation=horizontal]:mb-px data-[orientation=horizontal]:h-1.5 data-[orientation=vertical]:my-1 data-[orientation=vertical]:mr-px data-[orientation=vertical]:w-1.5 data-[orientation=horizontal]:flex-col data-hovering:opacity-100 data-scrolling:opacity-100 data-hovering:delay-0 data-scrolling:delay-0 data-hovering:duration-100 data-scrolling:duration-100",
        className,
      )}
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        className="relative flex-1 rounded-full bg-[var(--app-scrollbar-thumb)] transition-colors hover:bg-[var(--app-scrollbar-thumb-hover)]"
        data-slot="scroll-area-thumb"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, ScrollBar };

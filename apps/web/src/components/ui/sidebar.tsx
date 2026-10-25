import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { PanelLeft, PanelLeftClose } from "lucide";
import * as React from "react";
import { cn } from "~/lib/utils";
import { capturePanelFlip, playPanelFlip, type PanelFlipSnapshot } from "~/lib/panelFlip";
import { Button } from "~/components/ui/button";
import { Input, type InputProps } from "~/components/ui/input";
import { MorphIcon } from "~/components/MorphIcon";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useResizeDrag } from "~/hooks/useResizeDrag";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { resolveSidebarState, type ResponsiveSidebarState } from "./sidebarState";
import * as Schema from "effect/Schema";

const SIDEBAR_COOKIE_NAME = "sidebar_state";
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_WIDTH = "16rem";
const SIDEBAR_WIDTH_MOBILE = "calc(100vw - var(--spacing(3)))";
const SIDEBAR_WIDTH_ICON = "3rem";
const SIDEBAR_RESIZE_DEFAULT_MIN_WIDTH = 16 * 16;
// Touch-sized titlebar controls on phones only; a narrow desktop window keeps its own.
const SIDEBAR_TITLEBAR_CONTROL_SIZE =
  "sheet-layout:max-sm:[--workspace-titlebar-control-size:--spacing(8)]";

type SidebarContextProps = {
  state: ResponsiveSidebarState;
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  mobileSheetMounted: boolean;
  setMobileSheetElement: (element: HTMLDivElement | null) => void;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

type SidebarResizableOptions = {
  maxWidth?: number;
  minWidth?: number;
  onResize?: (width: number) => void;
  shouldAcceptWidth?: (context: {
    currentWidth: number;
    nextWidth: number;
    rail: HTMLButtonElement;
    side: "left" | "right";
    sidebarRoot: HTMLElement;
    wrapper: HTMLElement;
  }) => boolean;
  storageKey?: string;
};

type SidebarResolvedResizableOptions = {
  maxWidth: number;
  minWidth: number;
  onResize?: (width: number) => void;
  shouldAcceptWidth?: (context: {
    currentWidth: number;
    nextWidth: number;
    rail: HTMLButtonElement;
    side: "left" | "right";
    sidebarRoot: HTMLElement;
    wrapper: HTMLElement;
  }) => boolean;
  storageKey: string | null;
};

type SidebarInstanceContextProps = {
  resizable: SidebarResolvedResizableOptions | null;
  side: "left" | "right";
};

const SidebarContext = React.createContext<SidebarContextProps | null>(null);
const SidebarInstanceContext = React.createContext<SidebarInstanceContextProps | null>(null);

function useSidebar() {
  const context = React.use(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }

  return context;
}

function useSidebarVisibility() {
  const { isMobile, open, openMobile } = useSidebar();
  return isMobile ? openMobile : open;
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);
  const [mobileSheetMounted, setMobileSheetMounted] = React.useState(false);
  const setMobileSheetElement = React.useCallback((element: HTMLDivElement | null) => {
    setMobileSheetMounted(element !== null);
  }, []);

  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
  const [_open, _setOpen] = React.useState(defaultOpen);
  const open = openProp ?? _open;
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const flipSnapshotRef = React.useRef<PanelFlipSnapshot | null>(null);
  const setOpen = React.useCallback(
    async (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === "function" ? value(open) : value;
      // Only a user toggle animates: the snapshot is taken here, before the
      // layout changes, and played once the new state commits.
      const wrapper = wrapperRef.current;
      if (openState !== open && !isMobile && wrapper?.dataset.panelAnimations === "true") {
        flipSnapshotRef.current = capturePanelFlip(wrapper);
      }
      if (setOpenProp) {
        setOpenProp(openState);
      } else {
        _setOpen(openState);
      }

      // This sets the cookie to keep the sidebar state.
      await cookieStore.set({
        expires: Date.now() + SIDEBAR_COOKIE_MAX_AGE * 1000,
        name: SIDEBAR_COOKIE_NAME,
        path: "/",
        value: String(openState),
      });
    },
    [setOpenProp, open, isMobile],
  );

  // The gap snaps to its new width in one layout. The panel (marked, see
  // Sidebar) and the main pane's marked content then glide from where they
  // were, in one flip on one curve and duration, open and close alike, so
  // nothing lays out per frame or lags behind. Contained: a column that
  // resizes with the pane reflows once and keeps its left edge.
  React.useLayoutEffect(() => {
    const snapshot = flipSnapshotRef.current;
    flipSnapshotRef.current = null;
    const wrapper = wrapperRef.current;
    if (!snapshot || !wrapper) return;
    // The layout sets the duration inline; reading it there does not force
    // this commit's style pass before the flip has held what it keeps visible.
    const duration =
      Number.parseFloat(
        wrapper.style.getPropertyValue("--panel-animation-duration") ||
          getComputedStyle(wrapper).getPropertyValue("--panel-animation-duration"),
      ) || 0;
    if (duration > 0) playPanelFlip(snapshot, duration, { contain: true });
  }, [open]);

  // Helper to toggle the sidebar.
  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open);
  }, [isMobile, setOpen]);

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = resolveSidebarState({ isMobile, open, openMobile });

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      isMobile,
      open,
      openMobile,
      mobileSheetMounted,
      setMobileSheetElement,
      setOpen,
      setOpenMobile,
      state,
      toggleSidebar,
    }),
    [
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      mobileSheetMounted,
      setMobileSheetElement,
      toggleSidebar,
    ],
  );

  return (
    <SidebarContext value={contextValue}>
      <div
        ref={wrapperRef}
        // The app surface fills the layout, so nothing behind a moving panel
        // shows the window or page backdrop.
        className={cn(
          "group/sidebar-wrapper flex min-h-svh w-full bg-background",
          SIDEBAR_TITLEBAR_CONTROL_SIZE,
          className,
        )}
        data-sidebar-state={state}
        data-slot="sidebar-wrapper"
        style={
          {
            "--sidebar-width": SIDEBAR_WIDTH,
            "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
            "--workspace-titlebar-content-left":
              "calc(var(--workspace-controls-left) + var(--workspace-titlebar-control-size) + var(--workspace-titlebar-history-width, 0px) + var(--workspace-titlebar-control-gap))",
            ...style,
          } as React.CSSProperties
        }
        {...props}
      >
        {children}
      </div>
    </SidebarContext>
  );
}

function Sidebar({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  resizable = false,
  peek,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right";
  variant?: "sidebar" | "floating" | "inset";
  collapsible?: "offcanvas" | "icon" | "none";
  resizable?: boolean | SidebarResizableOptions;
  /**
   * A collapsed offcanvas sidebar floating over the page without taking room:
   * "open" shows it raised above the main pane, "closed" is its hidden state
   * with the same transition. Pass it from just before opening until the close
   * has settled, and leave it undefined otherwise so the toggle's own glide
   * runs alone.
   */
  peek?: "open" | "closed" | undefined;
}) {
  const { isMobile, state, openMobile, setOpenMobile, setMobileSheetElement } = useSidebar();
  const resolvedResizable = React.useMemo<SidebarResolvedResizableOptions | null>(() => {
    if (isMobile || collapsible === "none" || !resizable) {
      return null;
    }

    const options = typeof resizable === "boolean" ? {} : resizable;
    return {
      maxWidth: options.maxWidth ?? Number.POSITIVE_INFINITY,
      minWidth: options.minWidth ?? SIDEBAR_RESIZE_DEFAULT_MIN_WIDTH,
      storageKey: options.storageKey ?? null,
      ...(options.onResize ? { onResize: options.onResize } : {}),
      ...(options.shouldAcceptWidth ? { shouldAcceptWidth: options.shouldAcceptWidth } : {}),
    };
  }, [collapsible, isMobile, resizable]);
  const instanceContextValue = React.useMemo<SidebarInstanceContextProps>(
    () => ({ side, resizable: resolvedResizable }),
    [resolvedResizable, side],
  );

  if (collapsible === "none") {
    return (
      <SidebarInstanceContext value={instanceContextValue}>
        <div
          className={cn(
            "flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground",
            className,
          )}
          data-slot="sidebar"
          {...props}
        >
          {children}
        </div>
      </SidebarInstanceContext>
    );
  }

  if (isMobile) {
    return (
      <SidebarInstanceContext value={instanceContextValue}>
        <Sheet onOpenChange={setOpenMobile} open={openMobile}>
          <SheetPopup
            ref={setMobileSheetElement}
            className={cn(
              "w-(--sidebar-width) max-w-none bg-sidebar p-0 text-sidebar-foreground",
              className,
            )}
            data-mobile="true"
            data-sidebar="sidebar"
            data-slot="sidebar"
            showCloseButton={false}
            side={side}
            style={
              {
                "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
              } as React.CSSProperties
            }
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Sidebar</SheetTitle>
              <SheetDescription>Displays the mobile sidebar.</SheetDescription>
            </SheetHeader>
            <div
              className={cn(
                "flex h-full w-full flex-col pb-safe pt-safe",
                SIDEBAR_TITLEBAR_CONTROL_SIZE,
                side === "left" ? "pl-safe" : "pr-safe",
              )}
              {...props}
            >
              {children}
            </div>
          </SheetPopup>
        </Sheet>
      </SidebarInstanceContext>
    );
  }

  const peeking = peek !== undefined && collapsible === "offcanvas" && state === "collapsed";

  return (
    <SidebarInstanceContext value={instanceContextValue}>
      <div
        className="group peer hidden text-sidebar-foreground desktop-layout:block"
        data-collapsible={state === "collapsed" ? collapsible : ""}
        data-side={side}
        data-slot="sidebar"
        data-state={state}
        data-variant={variant}
        data-peek={peeking ? peek : undefined}
      >
        {/* This is what handles the sidebar gap on desktop */}
        <div
          className={cn(
            // The gap snaps to its new width in one layout; SidebarProvider
            // glides the main pane's marked content there on the compositor.
            // While the panel slides in, the gap shows beside it in the main
            // pane's color, so the pane reads as already making room. It spans
            // the full height: an empty block collapses to 0px tall and lets
            // the page backdrop show through the whole column.
            "relative h-full w-(--sidebar-width) bg-transparent group-data-[variant=sidebar]:bg-background",
            "[[data-collapsible=offcanvas]_&]:w-0",
            "group-data-[side=right]:rotate-180",
            variant === "floating" || variant === "inset"
              ? "[[data-collapsible=icon]_&]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
              : "[[data-collapsible=icon]_&]:w-(--sidebar-width-icon)",
          )}
          data-slot="sidebar-gap"
        />
        <div
          className={cn(
            "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) desktop-layout:flex",
            // Offcanvas open and close move the panel on a transform only, so
            // it runs on the compositor without relayout or repainting the
            // grain: the collapsed state puts it off-canvas, and a user toggle
            // glides it there from where it was, in the same flip as the main
            // pane's content (SidebarProvider, panelFlip), so its edge is the
            // pane's moving edge. A closed panel is invisible, out of the tab
            // order; the flip keeps it visible until it is out of sight.
            side === "left" ? "left-0" : "right-0",
            peeking
              ? cn(
                  // Over the main pane and its raised controls; the nav rail
                  // lifts above it so the column slides out from under it.
                  "z-[45] shadow-(--sidebar-peek-shadow) transition-[translate,visibility] motion-reduce:translate-x-0 motion-reduce:transition-[opacity,visibility]",
                  peek === "open"
                    ? "visible translate-x-0 duration-(--motion-duration-panel) ease-panel"
                    : cn(
                        // Closes on the same duration and curve it opens on;
                        // LIST_COLUMN_PEEK_SETTLE_MS waits it out.
                        "invisible duration-(--motion-duration-panel) ease-panel motion-reduce:opacity-0",
                        side === "left" ? "-translate-x-full" : "translate-x-full",
                      ),
                )
              : cn(
                  side === "left"
                    ? "[[data-collapsible=offcanvas]_&]:-translate-x-full"
                    : "[[data-collapsible=offcanvas]_&]:translate-x-full",
                  "[[data-collapsible=offcanvas]_&]:invisible",
                ),
            // Adjust the padding for floating and inset variants.
            variant === "floating" || variant === "inset"
              ? "p-2 [[data-collapsible=icon]_&]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"
              : "[[data-collapsible=icon]_&]:w-(--sidebar-width-icon) group-data-[side=right]:border-l",
            className,
          )}
          data-slot="sidebar-container"
          data-panel-flip="start"
          data-panel-flip-visible=""
          {...props}
        >
          <div
            className="flex h-full w-full flex-col bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow-sm/5"
            data-sidebar="sidebar"
            data-slot="sidebar-inner"
          >
            {/* Surface and contents slide as one unit, at a fixed width, under
                the rail: no fade, so nothing moves or reflows on its own. */}
            <div className="flex min-h-0 w-full flex-1 flex-col">{children}</div>
          </div>
        </div>
      </div>
    </SidebarInstanceContext>
  );
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar();
  // aria-disabled keeps the trigger hoverable for its tooltip but inert.
  const inert = props["aria-disabled"] === true || props["aria-disabled"] === "true";
  const isOpen = useSidebarVisibility() && !inert;

  return (
    <Button
      className={cn(
        "size-[var(--workspace-titlebar-control-size)]! [-webkit-app-region:no-drag]",
        className,
      )}
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      aria-pressed={isOpen}
      onClick={(event) => {
        onClick?.(event);
        // An onClick that handled the toggle itself prevents the default one.
        if (!inert && !event.defaultPrevented) toggleSidebar();
      }}
      // Chrome, like a native toolbar button: a click toggles the sidebar and
      // leaves focus (and its ring) where it was. Keyboard focus still rings.
      onPointerDown={(event) => event.preventDefault()}
      size="icon"
      variant="ghost-muted"
      {...props}
    >
      <MorphIcon className="size-4.5" icon={isOpen ? PanelLeftClose : PanelLeft} />
      <span className="sr-only">Toggle sidebar</span>
    </Button>
  );
}

function clampSidebarWidth(width: number, options: SidebarResolvedResizableOptions): number {
  return Math.max(options.minWidth, Math.min(width, options.maxWidth));
}

function SidebarRail({
  className,
  onClick,
  onPointerCancel,
  onLostPointerCapture,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  ...props
}: React.ComponentProps<"button">) {
  const { open, toggleSidebar } = useSidebar();
  const sidebarInstance = React.use(SidebarInstanceContext);
  const railRef = React.useRef<HTMLButtonElement | null>(null);
  const suppressClickRef = React.useRef(false);
  const resolvedResizable = sidebarInstance?.resizable ?? null;
  const latestResizable = React.useRef(resolvedResizable);
  const canResize = resolvedResizable !== null && open;
  const railLabel = canResize ? "Resize sidebar" : "Toggle sidebar";
  const railTitle = canResize ? "Drag to resize sidebar" : "Toggle sidebar";
  const resize = useResizeDrag<HTMLButtonElement>((event) => {
    if (!resolvedResizable || !open) return null;
    const rail = event.currentTarget;
    const wrapper = rail.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    const sidebarRoot = rail.closest<HTMLElement>("[data-slot='sidebar']");
    const sidebarContainer = sidebarRoot?.querySelector<HTMLElement>(
      "[data-slot='sidebar-container']",
    );
    if (!wrapper || !sidebarRoot || !sidebarContainer) return null;

    const side = sidebarInstance?.side ?? "left";
    let width = clampSidebarWidth(
      sidebarContainer.getBoundingClientRect().width,
      resolvedResizable,
    );
    // Drag frames write width to the gap and container only. Changing the
    // inherited --sidebar-width on the wrapper restyles the whole app, so it is
    // written once when the drag commits.
    const widthTargets = [
      sidebarRoot.querySelector<HTMLElement>("[data-slot='sidebar-gap']"),
      sidebarContainer,
    ].filter((element): element is HTMLElement => element !== null);
    const setTargetWidth = (value: number) => {
      widthTargets.forEach((element) => {
        element.style.setProperty("width", `${value}px`);
      });
    };
    widthTargets.forEach((element) => {
      element.style.setProperty("transition-duration", "0ms");
    });
    setTargetWidth(width);

    return {
      width,
      edge: side === "left" ? "right" : "left",
      resize(value) {
        const options = latestResizable.current;
        if (!options) return width;
        const nextWidth = clampSidebarWidth(value, options);
        const accepted =
          options.shouldAcceptWidth?.({
            currentWidth: width,
            nextWidth,
            rail,
            side,
            sidebarRoot,
            wrapper,
          }) ?? true;
        if (accepted) {
          setTargetWidth(nextWidth);
          width = nextWidth;
        }
        return width;
      },
      finish(finalWidth, moved) {
        wrapper.style.setProperty("--sidebar-width", `${finalWidth}px`);
        suppressClickRef.current = moved;
        const options = latestResizable.current;
        if (options?.storageKey) {
          try {
            setLocalStorageItem(options.storageKey, finalWidth, Schema.Finite);
          } catch (error) {
            console.error("Could not persist sidebar width.", error);
          }
        }
        options?.onResize?.(finalWidth);
      },
      cleanup() {
        widthTargets.forEach((element) => {
          element.style.removeProperty("width");
          element.style.removeProperty("transition-duration");
        });
      },
    };
    // Toggling the sidebar cancels a drag so the inline width never pins a
    // collapsed sidebar open.
  }, String(open));
  React.useLayoutEffect(() => {
    latestResizable.current = resolvedResizable;
    // Bounds follow the window; keep an active drag's inline width inside them.
    resize.refresh();
  }, [resolvedResizable]);

  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        event.preventDefault();
        return;
      }
      if (resolvedResizable && open) {
        event.preventDefault();
        return;
      }
      toggleSidebar();
    },
    [onClick, open, resolvedResizable, toggleSidebar],
  );

  React.useLayoutEffect(() => {
    if (!resolvedResizable?.storageKey || typeof window === "undefined") return;
    const rail = railRef.current;
    if (!rail) return;
    const wrapper = rail.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    if (!wrapper) return;

    let storedWidth: number | null;
    try {
      storedWidth = getLocalStorageItem(resolvedResizable.storageKey, Schema.Finite);
    } catch (error) {
      console.error("Could not restore persisted sidebar width.", error);
      return;
    }
    if (storedWidth === null) return;
    const clampedWidth = clampSidebarWidth(storedWidth, resolvedResizable);
    // Hydrate the CSS variable before the browser paints so a restored sidebar
    // never flashes at the default width first.
    wrapper.style.setProperty("--sidebar-width", `${clampedWidth}px`);
    resolvedResizable.onResize?.(clampedWidth);
  }, [resolvedResizable]);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={railLabel}
            className={cn(
              /* disable pointer events only when offcanvas sidebar is collapsed, that's when the rail sits over the native scrollbar on windows and linux. icon mode stays fully clickable. */
              "-translate-x-1/2 group-data-[side=left]:-right-4 absolute inset-y-0 z-20 hidden w-4 after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border group-data-[side=right]:left-0 sm:flex [[data-collapsible=offcanvas][data-state=collapsed]_&]:pointer-events-none",
              "transition-colors",
              "in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize",
              "[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
              "[[data-collapsible=offcanvas]_&]:translate-x-0 hover:[[data-collapsible=offcanvas]_&]:bg-sidebar [[data-collapsible=offcanvas]_&]:after:left-full",
              "[[data-side=left][data-collapsible=offcanvas]_&]:-right-2",
              "[[data-side=right][data-collapsible=offcanvas]_&]:-left-2",
              className,
            )}
            data-sidebar="rail"
            data-slot="sidebar-rail"
            onClick={handleClick}
            onLostPointerCapture={(event) => {
              onLostPointerCapture?.(event);
              if (!event.defaultPrevented) resize.onLostPointerCapture(event);
            }}
            onPointerCancel={(event) => {
              onPointerCancel?.(event);
              if (!event.defaultPrevented) resize.onPointerCancel(event);
            }}
            onPointerDown={(event) => {
              onPointerDown?.(event);
              if (!event.defaultPrevented) resize.onPointerDown(event);
            }}
            onPointerMove={(event) => {
              onPointerMove?.(event);
              if (!event.defaultPrevented) resize.onPointerMove(event);
            }}
            onPointerUp={(event) => {
              onPointerUp?.(event);
              if (!event.defaultPrevented) resize.onPointerUp(event);
            }}
            ref={railRef}
            tabIndex={-1}
            type="button"
            {...props}
          />
        }
      />
      <TooltipPopup side="right">{railTitle}</TooltipPopup>
    </Tooltip>
  );
}

/** A bare search or rename field that sits in a row of sidebar chrome. */
function SidebarInput({ className, ...props }: Omit<InputProps, "unstyled" | "variant">) {
  return (
    <Input
      className={cn(
        "[&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:font-medium [&_[data-slot=input]]:text-sidebar-foreground [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:placeholder:text-(--sidebar-input-placeholder,var(--sidebar-muted-foreground))",
        className,
      )}
      unstyled
      {...props}
    />
  );
}

/**
 * The main pane beside the sidebar. It takes no `peer-data-*` styles: a
 * `.peer[data-state] ~ *` rule makes every sidebar state change (a toggle, or
 * the list column stepping aside for the right panel) restyle the whole pane,
 * the entire app, twice per toggle.
 */
function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      className={cn("relative flex min-w-0 w-full flex-1 flex-col bg-background", className)}
      data-slot="sidebar-inset"
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2 p-2", className)}
      data-sidebar="header"
      data-slot="sidebar-header"
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2 px-[var(--sidebar-content-inset)] py-1", className)}
      data-sidebar="footer"
      data-slot="sidebar-footer"
      {...props}
    />
  );
}

function SidebarContent({
  className,
  fixedHeader,
  fixedFooter,
  ...props
}: React.ComponentProps<"div"> & {
  /** Pinned above the scrolling list, like a dock. */
  fixedHeader?: React.ReactNode;
  /** Pinned below the scrolling list, like a dock (the bottom sidebar layout). */
  fixedFooter?: React.ReactNode;
}) {
  return (
    <>
      {/* The dock sits right under the titlebar row, which already spaces itself, so its group
          keeps only a small top inset. The nav rail's mt-px puts its first icon on the same
          centre line as the dock (SidebarNavRail). */}
      {fixedHeader ? (
        <div className="w-full shrink-0 [&>[data-sidebar=group]:first-child]:pt-1.5">
          {fixedHeader}
        </div>
      ) : null}
      {/* Rows take focus on click. Scroll padding would make the browser nudge
          the list whenever a focused row sits under the fade. */}
      <ScrollArea
        hideScrollbars
        scrollFade
        scrollFadePadding={false}
        // Thread rows provide keyboard access to this scroll region. Keeping
        // Base UI's viewport out of the tab order lets its presentational role
        // flatten in WebKit instead of becoming a VoiceOver interaction group.
        viewportTabIndex={-1}
        // The list only scrolls vertically. Rows truncate to the column, and
        // the viewport clips sideways too, so a stray wide child can never
        // make the list pan.
        className="h-auto min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]]:overflow-x-hidden [&>[data-slot=scroll-area-viewport]]:overscroll-x-none [&>[data-slot=scroll-area-viewport]]:[--fade-size:0.75rem]"
      >
        <div
          // Reordered rows must not pull the viewport to their new position.
          className={cn(
            // Stacked groups share one inset between them instead of doubling
            // it, including across the fixed header's boundary.
            "flex w-full min-w-0 flex-col [overflow-anchor:none] [[data-collapsible=icon]_&]:overflow-hidden [&>[data-sidebar=group]+[data-sidebar=group]]:pt-0",
            fixedHeader && "[&>[data-sidebar=group]:first-child]:pt-0",
            fixedFooter && "[&>[data-sidebar=group]:last-child]:pb-0",
            className,
          )}
          data-sidebar="content"
          data-slot="sidebar-content"
          {...props}
        />
      </ScrollArea>
      {/* A docked footer has no titlebar row spacing it from the column's edge, so it keeps the
          group's full inset below it, matching the sides. */}
      {fixedFooter ? <div className="w-full shrink-0">{fixedFooter}</div> : null}
    </>
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative flex w-full min-w-0 flex-col p-[var(--sidebar-content-inset)]",
        className,
      )}
      data-sidebar="group"
      data-slot="sidebar-group"
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      className={cn("flex w-full min-w-0 flex-col gap-1", className)}
      data-sidebar="menu"
      data-slot="sidebar-menu"
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      className={cn("group/menu-item relative", className)}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
      {...props}
    />
  );
}

const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full cursor-pointer items-center gap-[var(--sidebar-control-gap)] overflow-hidden text-left outline-hidden ring-ring transition-[width,height,padding,color,background-color,box-shadow,opacity] state-hover focus-visible:ring-2 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-64 aria-disabled:pointer-events-none aria-disabled:opacity-64 data-[active=true]:state-selected data-[active=true]:font-medium [[data-collapsible=icon]_&]:size-8! [[data-collapsible=icon]_&]:p-[var(--sidebar-content-inset)]! [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-[var(--sidebar-icon-color)] hover:[&>svg]:text-sidebar-foreground active:[&>svg]:text-sidebar-foreground data-[active=true]:[&>svg]:text-sidebar-foreground",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default:
          "h-8 rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] py-1.5 text-sm",
        icon: "size-8 justify-center rounded-[var(--control-radius)] p-0",
        lg: "h-12 rounded-lg p-2 text-sm [[data-collapsible=icon]_&]:p-0!",
        sm: "h-7 rounded-lg p-2 text-xs",
      },
      variant: {
        default: "font-medium text-sidebar-muted-foreground/80",
        outline: "bg-sidebar-control-surface ring-1 ring-sidebar-border",
      },
    },
  },
);

function SidebarMenuButton({
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  render,
  ...props
}: useRender.ComponentProps<"button"> & {
  isActive?: boolean;
  tooltip?: string | React.ComponentProps<typeof TooltipPopup>;
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const { isMobile, state } = useSidebar();

  const defaultProps = {
    className: cn(sidebarMenuButtonVariants({ size, variant }), className),
    "data-active": isActive,
    "data-sidebar": "menu-button",
    "data-size": size,
    "data-slot": "sidebar-menu-button",
  };

  const buttonProps = mergeProps<"button">(defaultProps, props);

  const buttonElement = useRender({
    defaultTagName: "button",
    props: buttonProps,
    render,
  });

  if (!tooltip) {
    return buttonElement;
  }

  if (typeof tooltip === "string") {
    tooltip = {
      children: tooltip,
    };
  }

  return (
    <Tooltip>
      <TooltipTrigger render={buttonElement as React.ReactElement<Record<string, unknown>>} />
      <TooltipPopup
        align="center"
        hidden={state !== "collapsed" || isMobile}
        side="right"
        {...tooltip}
      />
    </Tooltip>
  );
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      className={cn(
        "mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-sidebar-border border-l px-2.5 py-0.5",
        "[[data-collapsible=icon]_&]:hidden",
        className,
      )}
      data-sidebar="menu-sub"
      data-slot="sidebar-menu-sub"
      {...props}
    />
  );
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      className={cn("group/menu-sub-item relative", className)}
      data-sidebar="menu-sub-item"
      data-slot="sidebar-menu-sub-item"
      {...props}
    />
  );
}

function SidebarMenuSubButton({
  size = "md",
  isActive = false,
  className,
  render,
  ...props
}: useRender.ComponentProps<"a"> & {
  size?: "sm" | "md";
  isActive?: boolean;
}) {
  const defaultProps = {
    className: cn(
      "-translate-x-px flex h-7 min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 text-sidebar-foreground outline-hidden ring-ring state-hover focus-visible:ring-2 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-64 aria-disabled:pointer-events-none aria-disabled:opacity-64 [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-muted-foreground",
      "data-[active=true]:state-selected",
      size === "sm" && "text-xs",
      size === "md" && "text-sm",
      "[[data-collapsible=icon]_&]:hidden",
      className,
    ),
    "data-active": isActive,
    "data-sidebar": "menu-sub-button",
    "data-size": size,
    "data-slot": "sidebar-menu-sub-button",
  };

  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(defaultProps, props),
    render,
  });
}

export {
  SidebarInput,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
  useSidebarVisibility,
};

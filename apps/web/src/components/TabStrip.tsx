import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { ScrollArea } from "~/components/ui/scroll-area";
import { TooltipProvider } from "~/components/ui/tooltip";

import { PanelTab, PanelTabContext } from "./PanelTab";
import {
  interleaveLeavingTabs,
  type LeavingTabSlot,
  tabSetChanges,
  tabStripFocusIndex,
  tabStripPanelId,
  tabStripTabId,
} from "./TabStrip.logic";

/** Arrivals and departures, on the base token, on the drawer's ease-out curve. */
const TAB_MOTION_MS = 220;
const TAB_MOTION_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const TAB_DRAG_MODIFIERS = [restrictToHorizontalAxis, restrictToFirstScrollableAncestor];

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function scrollViewport(root: HTMLDivElement | null): HTMLDivElement | null {
  return root?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null;
}

export interface TabStripProps<T extends { readonly id: string }> {
  readonly items: ReadonlyArray<T>;
  readonly activeId: string | null;
  readonly "aria-label": string;
  /** The tab's accessible name, also used for its close button and its title's tooltip. */
  readonly getLabel: (item: T) => string;
  /** What the title's tooltip shows instead of the label, such as a page's URL under its title. */
  readonly renderTooltip?: ((item: T) => ReactNode) | undefined;
  /** The tab's slots: PanelTab.Icon, .Label, .Status, .Action. */
  readonly renderTab: (item: T, state: { readonly active: boolean }) => ReactNode;
  readonly onActivate: (item: T) => void;
  /** Turns the icon slot into a × on hover, and closes on middle-click, Delete and Backspace. */
  readonly onClose?: (item: T) => void;
  /** Enables drag reorder: `item` was dropped on `over`'s place. */
  readonly onMove?: ((item: T, over: T) => void) | undefined;
  readonly isDragDisabled?: (item: T) => boolean;
  /**
   * Names one set of tabs. A strip switched to another set (another group,
   * another thread) shows it as it is; only changes within a set animate.
   */
  readonly setKey?: string | undefined;
  /** Gives tabs DOM ids and the selected one `aria-controls` (see tabStripTabId/PanelId). */
  readonly idPrefix?: string | undefined;
  /** Runs before the strip's own keys; call preventDefault to claim one. */
  readonly onTabKeyDown?: (
    event: ReactKeyboardEvent<HTMLElement>,
    item: T,
    tabElement: HTMLElement,
  ) => void;
  readonly onTabContextMenu?: (event: ReactMouseEvent<HTMLElement>, item: T) => void;
  readonly onTabDoubleClick?: (item: T) => void;
  /** After the last tab, in the tab lane, such as a "+". */
  readonly trailing?: ReactNode;
  readonly className?: string | undefined;
  /** Extra classes on every tab, such as a no-drag region in a titlebar. */
  readonly tabClassName?: string | undefined;
  /** Data attributes for the strip's root, such as hooks for layout motion. */
  readonly rootAttributes?: Readonly<Record<`data-${string}`, string | undefined>>;
}

/**
 * The one strip of closable, document-style tabs: browser, file and device
 * tabs in the right panel, agent tabs in the bottom drawer, after T3 Code's
 * panel tabs. Each tab is a PanelTab, as wide as its title up to a cap, its
 * × in the icon slot and its full title in a tooltip; a strip with more tabs
 * than room scrolls sideways (wheel included) with a fade on the clipped
 * edge, and keeps the selected tab in view.
 *
 * Keyboard: one tab stop; arrows, Home and End move focus without switching
 * (so walking past a terminal never mounts it), Enter or Space switches,
 * Delete or Backspace closes and lands focus on the tab that takes its place.
 * Middle-click closes. Only keyboard focus draws a ring. Arrivals open their
 * place and fade in, departures fold shut so neighbours slide rather than
 * jump; reduced motion fades only.
 */
export function TabStrip<T extends { readonly id: string }>(props: TabStripProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [leavingTabs, setLeavingTabs] = useState<ReadonlyArray<LeavingTabSlot>>([]);
  const { items, activeId } = props;

  // Runs only when the set of tabs changes, never per render: the widths a
  // closing tab folds from come from a resize observer (each tab's border box
  // as last laid out), so no commit reads layout to keep them.
  const seenRef = useRef<{ setKey: string | undefined; ids: string[] } | null>(null);
  const lastWidthsRef = useRef(new Map<string, number>());
  const ids = items.map((item) => item.id);
  const tabSetKey = `${props.setKey ?? ""}\u0000${ids.join("\u0000")}`;
  const syncTabSet = useEffectEvent(() => {
    const seen = seenRef.current;
    seenRef.current = { setKey: props.setKey, ids };
    const root = rootRef.current;
    if (seen !== null && seen.setKey === props.setKey && root) {
      const { arrivals, departures } = tabSetChanges(seen.ids, ids);
      const reduced = reducedMotion();
      // Every read, then every write: one layout for all arrivals.
      const measured: Array<{ element: HTMLElement; width: number }> = [];
      for (const id of arrivals) {
        const element = root.querySelector<HTMLElement>(`[data-tab-id="${window.CSS.escape(id)}"]`);
        if (element) measured.push({ element, width: element.getBoundingClientRect().width });
      }
      // The tab fades in where it will sit: its content is held at its final
      // width while the slot opens, so the title does not reflow or slide as
      // the neighbours ease aside. Reduced motion keeps the fade alone.
      for (const { element, width } of measured) {
        if (reduced) {
          element.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: TAB_MOTION_MS,
            easing: "ease-out",
          });
          continue;
        }
        const content = element.firstElementChild;
        if (content instanceof HTMLElement) content.style.width = `${width}px`;
        const animation = element.animate(
          [
            { width: "0px", opacity: 0 },
            { width: `${width}px`, opacity: 1 },
          ],
          { duration: TAB_MOTION_MS, easing: TAB_MOTION_EASING },
        );
        const release = () => {
          if (content instanceof HTMLElement) content.style.width = "";
        };
        animation.addEventListener("finish", release, { once: true });
        animation.addEventListener("cancel", release, { once: true });
      }
      if (departures.length > 0 && !reduced) {
        setLeavingTabs((leaving) => [
          ...leaving,
          ...departures.flatMap(({ id, afterId }) => {
            const width = lastWidthsRef.current.get(id);
            return width ? [{ id, afterId, width }] : [];
          }),
        ]);
      }
      for (const { id } of departures) lastWidthsRef.current.delete(id);
    } else if (seen !== null) {
      setLeavingTabs([]);
      lastWidthsRef.current.clear();
    }
    if (!root) return;
    const tabs = Array.from(root.querySelectorAll<HTMLElement>("[data-tab-id]"));
    return observeResize(tabs, (entries) => {
      for (const entry of entries) {
        const id = entry.target instanceof HTMLElement ? entry.target.dataset.tabId : undefined;
        const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
        if (id) lastWidthsRef.current.set(id, width);
      }
    });
  });
  // Keyed on the tab set: a title change resizes its tab, and the observed
  // sizes follow it on their own.
  // eslint-disable-next-line react/exhaustive-effect-dependencies -- keyed on the tab set
  useLayoutEffect(() => syncTabSet(), [tabSetKey]);
  const dismissLeaving = useCallback(
    (id: string) => setLeavingTabs((leaving) => leaving.filter((slot) => slot.id !== id)),
    [],
  );
  const entries = useMemo(() => interleaveLeavingTabs(items, leavingTabs), [items, leavingTabs]);

  // Set while focus in the strip came from the pointer, cleared by a key in
  // it or by focus arriving from elsewhere in the page; PanelTab and the
  // tab's ring read it so a clicked tab never takes the keyboard look.
  const markPointerFocus = (pointer: boolean, element: HTMLElement) => {
    if (pointer) element.dataset.pointerFocus = "";
    else delete element.dataset.pointerFocus;
  };

  const tabElements = () =>
    Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
  // Set when the keyboard closed a tab, so focus lands on the tab that takes
  // its place once the close renders (an owner may first ask to confirm).
  const focusAfterCloseRef = useRef<string | null>(null);
  useEffect(() => {
    const closedId = focusAfterCloseRef.current;
    if (closedId === null || items.some((item) => item.id === closedId)) return;
    focusAfterCloseRef.current = null;
    rootRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  });

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    markPointerFocus(false, event.currentTarget);
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const tab = event.target;
    if (!(tab instanceof HTMLElement) || tab.getAttribute("role") !== "tab") return;
    const item = items.find((entry) => entry.id === tab.dataset.tabId);
    if (!item) return;
    props.onTabKeyDown?.(event, item, tab);
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const tabs = tabElements();
    const next = tabStripFocusIndex(event.key, tabs.indexOf(tab), tabs.length);
    if (next !== null) {
      event.preventDefault();
      tabs[next]?.focus();
      return;
    }
    switch (event.key) {
      case "Enter":
      case " ":
        event.preventDefault();
        props.onActivate(item);
        return;
      case "Delete":
      case "Backspace":
        if (!props.onClose) return;
        event.preventDefault();
        focusAfterCloseRef.current = item.id;
        props.onClose(item);
        return;
    }
  };

  useEffect(() => {
    if (!activeId || !hasOverflow) return;
    rootRef.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, hasOverflow]);

  // The wheel scrolls an overflowing strip sideways.
  useEffect(() => {
    const viewport = scrollViewport(rootRef.current);
    if (!viewport) return;
    const update = () => setHasOverflow(viewport.scrollWidth - viewport.clientWidth > 1);
    const content = viewport.firstElementChild;
    const stopObserving = observeResize(content ? [viewport, content] : viewport, update);
    update();
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      let delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= viewport.clientWidth;
      if (delta === 0) return;
      const previousScrollLeft = viewport.scrollLeft;
      viewport.scrollLeft += delta;
      if (viewport.scrollLeft === previousScrollLeft) return;
      event.preventDefault();
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      stopObserving();
      viewport.removeEventListener("wheel", handleWheel);
    };
  }, []);

  const { onMove } = props;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!over || active.id === over.id) return;
      const moved = items.find((item) => item.id === active.id);
      const target = items.find((item) => item.id === over.id);
      if (moved && target) onMove?.(moved, target);
    },
    [items, onMove],
  );
  const anyActive = items.some((item) => item.id === activeId);

  return (
    <ScrollArea
      radius="none"
      ref={rootRef}
      hideScrollbars
      scrollFade
      scrollFadePadding={false}
      className={cn("min-w-0 flex-1", props.className)}
      {...props.rootAttributes}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={TAB_DRAG_MODIFIERS}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
          <TooltipProvider delay={500} closeDelay={0} timeout={400}>
            <div
              role="tablist"
              aria-label={props["aria-label"]}
              aria-orientation="horizontal"
              className="relative flex h-full w-full items-center gap-1"
              onKeyDown={handleKeyDown}
              onPointerDownCapture={(event) => markPointerFocus(true, event.currentTarget)}
              onFocus={(event) => {
                // From another control (a Tab press); a null origin is the
                // window refocusing, which keeps how focus last arrived.
                const from = event.relatedTarget;
                if (from instanceof Node && !event.currentTarget.contains(from)) {
                  markPointerFocus(false, event.currentTarget);
                }
              }}
            >
              {entries.map((entry) => {
                if (entry.kind === "leaving") {
                  const { slot } = entry;
                  return (
                    <LeavingTab
                      key={`leaving:${slot.id}`}
                      width={slot.width}
                      onDone={() => dismissLeaving(slot.id)}
                    />
                  );
                }
                const { item, index } = entry;
                const active = item.id === activeId;
                const label = props.getLabel(item);
                // One tab stop for the whole strip: the selected tab, or the
                // first one while nothing is selected.
                const tabStop = active || (!anyActive && index === 0);
                return (
                  <SortableTab
                    key={item.id}
                    tabId={item.id}
                    disabled={!onMove || (props.isDragDisabled?.(item) ?? false)}
                    role="tab"
                    id={props.idPrefix ? tabStripTabId(props.idPrefix, index) : undefined}
                    aria-selected={active}
                    aria-controls={
                      active && props.idPrefix ? tabStripPanelId(props.idPrefix) : undefined
                    }
                    aria-label={label}
                    tabIndex={tabStop ? 0 : -1}
                    onClick={(event) => {
                      // The buttons inside the tab act on their own.
                      if (event.target instanceof Element && event.target.closest("button")) return;
                      props.onActivate(item);
                    }}
                    onDoubleClick={
                      props.onTabDoubleClick ? () => props.onTabDoubleClick?.(item) : undefined
                    }
                    // Middle-click closes, and never starts the autoscroll cursor.
                    onMouseDown={(event) => {
                      if (event.button === 1) event.preventDefault();
                    }}
                    onAuxClick={(event) => {
                      if (event.button !== 1 || !props.onClose) return;
                      event.preventDefault();
                      event.stopPropagation();
                      props.onClose(item);
                    }}
                    onContextMenu={
                      props.onTabContextMenu
                        ? (event) => props.onTabContextMenu?.(event, item)
                        : undefined
                    }
                    className={cn(
                      // As wide as its title, up to a cap past which the title
                      // truncates. Only keyboard focus draws a ring, an outline
                      // so the selected tab's fill does not cover it; PanelTab
                      // draws the rest.
                      "relative h-6 max-w-36 shrink-0 cursor-pointer overflow-hidden rounded-md outline-none [[role=tablist]:not([data-pointer-focus])_&:focus-visible]:outline-2 [[role=tablist]:not([data-pointer-focus])_&:focus-visible]:outline-solid [[role=tablist]:not([data-pointer-focus])_&:focus-visible]:outline-ring",
                      props.tabClassName,
                    )}
                  >
                    <PanelTabContext
                      value={{
                        label,
                        onClose: props.onClose ? () => props.onClose?.(item) : undefined,
                        tooltip: props.renderTooltip?.(item) ?? label,
                      }}
                    >
                      <PanelTab.Body active={active}>
                        {props.renderTab(item, { active })}
                      </PanelTab.Body>
                    </PanelTabContext>
                  </SortableTab>
                );
              })}
              {props.trailing}
            </div>
          </TooltipProvider>
        </SortableContext>
      </DndContext>
    </ScrollArea>
  );
}

/** A tab that can be dragged into a new order; neighbours slide aside, and the order commits on drop. */
function SortableTab({
  tabId,
  disabled,
  className,
  style,
  ...props
}: ComponentProps<"div"> & { tabId: string; disabled: boolean }) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tabId,
    disabled,
  });
  return (
    <div
      {...props}
      {...listeners}
      ref={setNodeRef}
      data-tab-id={tabId}
      // The drag adds its own translate.
      style={{ ...style, transform: CSS.Translate.toString(transform), transition }}
      className={cn(className, isDragging && "relative z-10")}
    />
  );
}

/**
 * A closed tab's place, folding shut so the tabs after it slide over rather
 * than jump. Inert: it is only geometry.
 */
function LeavingTab({ width, onDone }: { width: number; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || reducedMotion()) {
      onDone();
      return;
    }
    const animation = element.animate(
      [
        { width: `${width}px`, opacity: 1 },
        { width: "0px", opacity: 0 },
      ],
      { duration: TAB_MOTION_MS, easing: TAB_MOTION_EASING, fill: "forwards" },
    );
    animation.onfinish = onDone;
    return () => animation.cancel();
    // Plays once, for the width it closed at.
    // eslint-disable-next-line react/exhaustive-effect-dependencies -- a mount-only animation
  }, []);
  return <div ref={ref} aria-hidden className="h-6 shrink-0 overflow-hidden" />;
}

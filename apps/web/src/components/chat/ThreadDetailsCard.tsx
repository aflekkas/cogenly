import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { cn } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverCreateHandle } from "../ui/popover";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import { useChatCanvas } from "./ChatCanvasContext";
import { ThreadDetailsSurface } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_CARD_GAP,
  resolveThreadDetailsCardDensity,
  resolveThreadDetailsCardLayout,
} from "./threadDetailsCardLayout";
import { observeResize } from "../../lib/observeResize";
import { usePanelAnimationSettings, usePanelPresence } from "../../panelAnimations";

/** Matches popup-motion's exit, so the card unmounts as its fade ends. */
const THREAD_DETAILS_CARD_EXIT_MS = 110;

/** One card owns its placement and folds content only when that content cannot fit. */
export function ThreadDetailsCard({
  threadRef,
  anchor,
  handle,
  onPresentationChange,
  children,
}: {
  threadRef: ScopedThreadRef;
  anchor: RefObject<Element | null>;
  handle: ReturnType<typeof PopoverCreateHandle>;
  onPresentationChange: (presentation: ThreadPanelPresentation) => void;
  children: (density: "full" | "compact" | "essential") => ReactNode;
}) {
  const canvas = useChatCanvas();
  const preferredPlacement = canvas
    ? resolveThreadDetailsCardLayout({
        container: canvas.container,
        lane: canvas.lane,
        frame: null,
        topInset: canvas.detailsCardTopInset,
      })
    : null;
  const placement = canvas
    ? resolveThreadDetailsCardLayout({
        container: canvas.container,
        lane: canvas.lane,
        frame: canvas.layout.frame,
        overlapsDetailsCard: canvas.layout.overlapsDetailsCard,
        topInset: canvas.detailsCardTopInset,
      })
    : null;
  const mode = placement ? "inline" : "popover";
  const topInset = canvas?.detailsCardTopInset ?? 0;
  const inlineOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "inline"),
  );
  const popoverOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "popover"),
  );
  const { active: motionActive } = usePanelAnimationSettings();
  const inlinePresent = usePanelPresence(
    inlineOpen,
    true,
    motionActive,
    `${threadRef.environmentId}:${threadRef.threadId}`,
    THREAD_DETAILS_CARD_EXIT_MS,
  ).present;
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null);
  const measurementKey = `${threadRef.environmentId}:${threadRef.threadId}:${preferredPlacement?.width ?? "popup"}`;
  const [measurements, setMeasurements] = useState({
    key: measurementKey,
    heights: { full: 0, compact: 0 },
    fullContentHeight: 0,
  });
  const contentHeights =
    measurements.key === measurementKey ? measurements.heights : { full: 0, compact: 0 };
  const height = placement?.height ?? Math.max(0, (canvas?.container.height ?? 0) - 52);
  const density = resolveThreadDetailsCardDensity(height, contentHeights);
  const reportDetailsCard = canvas?.reportDetailsCard;
  const cardLeft = preferredPlacement?.x;
  const cardRight = preferredPlacement
    ? preferredPlacement.x + preferredPlacement.width
    : undefined;
  const cardBottom =
    preferredPlacement && measurements.key === measurementKey && measurements.fullContentHeight > 0
      ? preferredPlacement.y + Math.min(measurements.fullContentHeight, preferredPlacement.height)
      : undefined;
  useLayoutEffect(() => {
    reportDetailsCard?.(
      inlineOpen && cardLeft !== undefined && cardRight !== undefined && cardBottom !== undefined
        ? { left: cardLeft, right: cardRight, bottom: cardBottom }
        : null,
    );
  }, [reportDetailsCard, inlineOpen, cardLeft, cardRight, cardBottom]);
  useLayoutEffect(() => () => reportDetailsCard?.(null), [reportDetailsCard]);
  useLayoutEffect(() => {
    onPresentationChange(mode);
    if (mode === "inline" && popoverOpen)
      useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", false);
  }, [mode, onPresentationChange, threadRef, popoverOpen]);
  useLayoutEffect(() => {
    const element = contentElement;
    if (!element || density === "essential") return;
    // Measure the single content tree before the scroll viewport clips it. Retain each
    // observed height so increasing available space restores the detail it can hold.
    const measure = () => {
      const frame = element.closest<HTMLElement>("[data-thread-details-card]");
      const next = element.offsetHeight + (frame ? frame.offsetHeight - frame.clientHeight : 0);
      // Lineage scrolls as it expands. Counting it toward density would hide
      // the section and workspace controls when the user asks to see more rows.
      const lineage = element.querySelector<HTMLElement>("[data-thread-relationships-panel]");
      const fittingHeight = next - (lineage?.offsetHeight ?? 0);
      setMeasurements((current) => {
        const heights = current.key === measurementKey ? current.heights : { full: 0, compact: 0 };
        const fullContentHeight =
          density === "full"
            ? next
            : current.key === measurementKey
              ? current.fullContentHeight
              : 0;
        return current.key === measurementKey &&
          heights[density] === fittingHeight &&
          current.fullContentHeight === fullContentHeight
          ? current
          : {
              key: measurementKey,
              heights: { ...heights, [density]: fittingHeight },
              fullContentHeight,
            };
      });
    };
    measure();
    return observeResize(element, measure);
  }, [contentElement, density, measurementKey]);
  const card = (
    <ThreadDetailsSurface
      floating={mode === "popover"}
      contentRef={setContentElement}
      style={placement ? { maxHeight: height } : undefined}
      data-thread-details-card
    >
      {children(density)}
    </ThreadDetailsSurface>
  );
  return (
    <Popover
      handle={handle}
      open={mode === "popover" && popoverOpen}
      onOpenChange={(open, details) => {
        // The find bar sits beside the card, so clicking or focusing it does not
        // dismiss the card. Escape still does.
        const target =
          details.reason === "focus-out"
            ? (details.event as FocusEvent).relatedTarget
            : details.reason === "outside-press"
              ? details.event.target
              : null;
        if (!open && target instanceof Element && target.closest("[data-thread-find-bar]")) {
          details.cancel();
          return;
        }
        useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", open);
      }}
    >
      {placement ? (
        inlinePresent ? (
          <aside
            aria-label="Thread details"
            aria-hidden={!inlineOpen || undefined}
            inert={!inlineOpen}
            // Opens and closes like an anchored popup (popup-motion): a fade from
            // 97% scale out of the top-right corner, with a quicker exit. Slides down
            // to make room for the find bar, but returns in the same frame the bar
            // closes: a floating preview below moves up at once and would otherwise
            // overlap the card mid-slide.
            className={cn(
              "absolute z-20 origin-top-right",
              topInset > 0 &&
                "transition-[top] duration-150 ease-out motion-reduce:transition-none",
              topInset > 0
                ? "[[data-panel-animations=true]_&]:transition-[top,opacity,scale,translate]"
                : "[[data-panel-animations=true]_&]:transition-[opacity,scale,translate]",
              "[[data-panel-animations=true]_&]:duration-160 [[data-panel-animations=true]_&]:ease-drawer [[data-panel-animations=true]_&]:starting:-translate-y-1 [[data-panel-animations=true]_&]:starting:scale-97 [[data-panel-animations=true]_&]:starting:opacity-0",
              !inlineOpen &&
                "pointer-events-none scale-97 opacity-0 [[data-panel-animations=true]_&]:duration-110 [[data-panel-animations=true]_&]:ease-popup-exit",
            )}
            style={{
              // Anchored to the right edge like the find bar, so both follow a resizing
              // canvas in the same frame instead of waiting for its next measurement.
              right: placement.right,
              top: placement.y,
              width: placement.width,
              maxHeight: height,
            }}
            data-density={density}
            data-thread-details-panel="inline"
            // Held to the canvas's right edge: it stays put while the chat
            // lane around it glides on a panel toggle.
            data-panel-flip="end"
          >
            {card}
          </aside>
        ) : null
      ) : (
        <PopoverPopup
          anchor={anchor}
          align="end"
          // Lines the card up with the find bar: the panel pads its card by 8px.
          alignOffset={THREAD_DETAILS_CARD_GAP - 8}
          collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
          side="bottom"
          sideOffset={topInset}
          variant="panel"
          padding="none"
        >
          <div data-density={density} data-thread-details-panel="popover">
            {card}
          </div>
        </PopoverPopup>
      )}
    </Popover>
  );
}

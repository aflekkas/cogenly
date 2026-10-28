"use client";

import { Children, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { observeResize } from "../lib/observeResize";
import { DisclosurePanel } from "./ui/disclosure";

const HEIGHT_TRANSITION_FALLBACK_MS = 250;

/**
 * Eases its own height as its content changes size. Content that appears or
 * leaves entirely (children turn empty) goes through `DisclosurePanel`: the
 * departing content stays mounted while its height and opacity close together,
 * and arriving content grows in while it fades. Content present at mount
 * stays still. Reduced motion keeps only the fade in.
 */
export function AnimatedHeight({
  children,
  holdHeight = false,
}: {
  readonly children: ReactNode;
  /** Retain the previous content height while a replacement is loading. */
  readonly holdHeight?: boolean;
}) {
  const present = Children.toArray(children).length > 0;
  return (
    // `data-empty` lets a divided settings card drop the separator at once.
    <div data-slot="animated-height" data-empty={present ? undefined : ""}>
      <DisclosurePanel open={present}>
        <MeasuredHeight holdHeight={holdHeight}>{children}</MeasuredHeight>
      </DisclosurePanel>
    </div>
  );
}

function MeasuredHeight({
  children,
  holdHeight,
}: {
  readonly children: ReactNode;
  readonly holdHeight: boolean;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [heightState, setHeightState] = useState<{
    readonly height: number | null;
    readonly isClipping: boolean;
  }>({ height: null, isClipping: false });

  const { height, isClipping } = heightState;
  // Unclips if transitionend never fires. Each new target height restarts the
  // timer, so a resize mid-motion still gets its full transition. A clipping
  // state always has a measured height.
  useEffect(() => {
    if (!isClipping || height === null) return;
    const timeoutId = window.setTimeout(() => {
      setHeightState((currentState) =>
        currentState.isClipping ? { ...currentState, isClipping: false } : currentState,
      );
    }, HEIGHT_TRANSITION_FALLBACK_MS);
    return () => window.clearTimeout(timeoutId);
  }, [height, isClipping]);

  useLayoutEffect(() => {
    if (holdHeight) return;
    const element = contentRef.current;
    if (!element) return;
    let firstFrameId: number | null = null;
    let secondFrameId: number | null = null;

    const updateHeight = () => {
      const nextHeight = Math.ceil(element.scrollHeight || element.getBoundingClientRect().height);
      setHeightState((currentState) => {
        if (currentState.height === nextHeight) return currentState;
        return {
          height: nextHeight,
          isClipping: currentState.height !== null,
        };
      });
    };
    const cancelPendingFrames = () => {
      if (firstFrameId !== null) {
        window.cancelAnimationFrame(firstFrameId);
        firstFrameId = null;
      }
      if (secondFrameId !== null) {
        window.cancelAnimationFrame(secondFrameId);
        secondFrameId = null;
      }
    };
    const updateHeightAfterPaint = () => {
      cancelPendingFrames();
      updateHeight();
      firstFrameId = window.requestAnimationFrame(() => {
        firstFrameId = null;
        updateHeight();
        secondFrameId = window.requestAnimationFrame(() => {
          secondFrameId = null;
          updateHeight();
        });
      });
    };

    updateHeightAfterPaint();
    const stopObserving = observeResize(element, updateHeightAfterPaint);
    return () => {
      stopObserving();
      cancelPendingFrames();
    };
  }, [holdHeight]);

  return (
    <div
      className="transition-[height] duration-200 ease-out motion-reduce:transition-none [overflow-clip-margin:2px]"
      style={
        heightState.height === null
          ? undefined
          : { height: heightState.height, overflow: heightState.isClipping ? "clip" : "visible" }
      }
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== "height") return;
        setHeightState((currentState) =>
          currentState.isClipping ? { ...currentState, isClipping: false } : currentState,
        );
      }}
    >
      <div ref={contentRef} style={holdHeight ? { height: "100%" } : undefined}>
        {children}
      </div>
    </div>
  );
}

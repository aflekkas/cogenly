"use client";

import { useLayoutEffect, useRef } from "react";

import { acquireBrowserSurface } from "./browserSurfaceStore";
import { observeResize } from "../lib/observeResize";
import { subscribePanelMotion } from "../lib/panelFlip";

export function BrowserSurfaceSlot(props: {
  readonly tabId: string;
  readonly visible: boolean;
  readonly className?: string;
}) {
  const { tabId, visible, className } = props;
  const elementRef = useRef<HTMLDivElement | null>(null);
  const visibleRef = useRef(visible);
  const updateRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let lease = acquireBrowserSurface(tabId);
    const update = () => {
      const rect = element.getBoundingClientRect();
      const bounds = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      };
      const hasArea = rect.width > 0 && rect.height > 0;
      const presented = lease.present(bounds, visibleRef.current && hasArea);
      if (visibleRef.current && !presented) {
        lease.release();
        lease = acquireBrowserSurface(tabId);
        lease.present(bounds, hasArea);
      }
    };
    updateRef.current = update;
    update();
    const observed: Element[] = [element];
    // An inline panel's slot can move without resizing (the panel resizes
    // around full-width content), so measure on shell resizes too.
    const panel = element.closest('[data-preview-panel-mode="inline"]');
    if (panel) observed.push(panel);
    // A sidebar opening or closing shifts the whole column, so a slot that keeps
    // its size and its offset inside the column still moves on screen. The gap
    // element carries the sidebar's width.
    observed.push(...document.querySelectorAll('[data-slot="sidebar-gap"]'));
    const stopObserving = observeResize(observed, update);
    // Panels slide and content glides on transforms, which no resize reports.
    const stopFollowingPanels = subscribePanelMotion(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      stopObserving();
      stopFollowingPanels();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      if (updateRef.current === update) updateRef.current = null;
      lease.release();
    };
  }, [tabId]);

  useLayoutEffect(() => {
    visibleRef.current = visible;
    updateRef.current?.();
  }, [visible]);

  return <div ref={elementRef} className={className} data-browser-surface-slot={tabId} />;
}

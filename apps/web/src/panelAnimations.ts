import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type PanelAnimationDurationMs } from "@cogenly/contracts/settings";

import { useMediaQuery } from "./hooks/useMediaQuery";
import { PANEL_MOTION_SETTLE_MS } from "./lib/panelFlip";

/**
 * The sidebar and list column, right panel and bottom drawer all open and
 * close at this duration, on PANEL_MOTION_EASING: --motion-duration-panel and
 * --ease-panel in index.css, kept in step by hand. Past the 150-220ms
 * guideline on purpose: a panel slide moves a large area, and shorter reads
 * as the content being shoved aside.
 */
const PANEL_ANIMATION_DURATION_MS: PanelAnimationDurationMs = 300;

/** The panel motion's duration, for a caller that reads whether it plays at event time. */
export const PANEL_ANIMATION_DURATION = PANEL_ANIMATION_DURATION_MS;

/**
 * --motion-duration-base, for layout glides on the panel motion's curve that
 * are not a panel opening or closing: the draft hero docking on send and the
 * composer's resting controls.
 */
export const LAYOUT_MOTION_DURATION = 220;

/**
 * Whether the first painted frame of a navigation is still pending. An
 * external flag, not React state or context: the components that animate
 * panels read it when a change happens (in handlers and effects), so a
 * navigation flipping it never re-renders them. AppSidebarLayout owns it.
 */
let navigationSuppressed = false;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;
}

/**
 * Whether a panel change happening now animates: never under reduced motion,
 * nor in the first painted frame of a navigation, whose restored state must
 * be visible immediately. Read it at event time, never during render.
 */
export function readPanelAnimationsActive(): boolean {
  return !navigationSuppressed && !prefersReducedMotion();
}

/**
 * Suppresses panel motion for the first painted frame of an initial route or navigation.
 * State restored by a route must be visible immediately; later user actions can animate.
 * Publishes the result to `readPanelAnimationsActive`; only the caller re-renders.
 */
export function usePanelNavigationSuppression(navigationKey: string): boolean {
  const [paintedNavigationKey, setPaintedNavigationKey] = useState<string | null>(null);
  const suppressed = paintedNavigationKey !== navigationKey;
  // Written during render so the views rendering in this same pass, and their
  // layout effects, already see a navigation as suppressed; the effect below
  // keeps it true to what committed.
  publishNavigationSuppressed(suppressed);

  useLayoutEffect(() => {
    publishNavigationSuppressed(suppressed);
    if (!suppressed) return;
    let releaseFrame = 0;
    const paintFrame = window.requestAnimationFrame(() => {
      releaseFrame = window.requestAnimationFrame(() => {
        publishNavigationSuppressed(false);
        setPaintedNavigationKey(navigationKey);
      });
    });
    return () => {
      window.cancelAnimationFrame(paintFrame);
      window.cancelAnimationFrame(releaseFrame);
    };
  }, [navigationKey, suppressed]);

  return suppressed;
}

function publishNavigationSuppressed(suppressed: boolean): void {
  navigationSuppressed = suppressed;
}

/** For the layout that owns the suppression and styles panel motion from its own render. */
export function usePanelAnimationSettings(): {
  active: boolean;
  durationMs: PanelAnimationDurationMs;
} {
  const durationMs = PANEL_ANIMATION_DURATION_MS;
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  return { active: !reducedMotion, durationMs };
}

/**
 * Keeps closing panel content mounted until its transition ends. Whether the
 * close animates is read when it happens (readPanelAnimationsActive); one
 * that does not leaves before the frame paints.
 */
export function usePanelPresence<T>(
  open: boolean,
  value: T | null,
  scopeKey: string | null,
  durationMs: PanelAnimationDurationMs,
): { present: boolean; value: T | null } {
  const [present, setPresent] = useState(open);
  const retainedRef = useRef<{ scopeKey: string | null; value: T | null } | null>(
    open ? { scopeKey, value } : null,
  );

  useEffect(() => {
    if (open) retainedRef.current = { scopeKey, value };
  }, [open, scopeKey, value]);

  useLayoutEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!readPanelAnimationsActive()) {
      setPresent(false);
      return;
    }

    // The glide starts a frame after the close commits (panelFlip); the panel
    // stays until it has left.
    const timeout = window.setTimeout(() => setPresent(false), durationMs + PANEL_MOTION_SETTLE_MS);
    return () => window.clearTimeout(timeout);
  }, [durationMs, open]);

  const retainedValue =
    retainedRef.current?.scopeKey === scopeKey ? retainedRef.current.value : null;
  const visible = open || (present && retainedRef.current?.scopeKey === scopeKey);
  return { present: visible, value: open ? value : visible ? retainedValue : null };
}

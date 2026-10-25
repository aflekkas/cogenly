import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";

import { modeSwitchCrossfadeRunning } from "../sidebar/modes/modeSwitchMotion";
import { useLastPresent } from "../ui/overlay-presence";
import { takeLeavingCopy } from "./StateTransition.logic";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function motionDurationMs(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--motion-duration-base");
  const ms = Number.parseFloat(raw);
  return Number.isFinite(ms) ? ms : 200;
}

interface LeavingCopy {
  readonly source: HTMLElement;
  readonly copy: HTMLElement;
}

// What a swapping item left behind in the commit that removed it, by group. The
// item that replaces it in the same commit picks it up and cross-fades; one that
// nothing replaces (the user left the screen) is dropped.
const leaving = new Map<string, LeavingCopy>();

const INHERITED_TEXT_STYLES = [
  "font",
  "color",
  "letterSpacing",
  "lineHeight",
  "textAlign",
  "whiteSpace",
] as const;

function captureLeavingCopy(group: string, source: HTMLElement) {
  const box = source.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return;
  const copy = source.cloneNode(true) as HTMLElement;
  const computed = getComputedStyle(source);
  for (const property of INHERITED_TEXT_STYLES) copy.style[property] = computed[property];
  Object.assign(copy.style, {
    position: "fixed",
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    margin: "0",
    pointerEvents: "none",
  });
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  const entry = { source, copy };
  leaving.set(group, entry);
  // The replacement commits in the same task; anything left after it was not replaced.
  setTimeout(() => {
    if (leaving.get(group) === entry) leaving.delete(group);
  }, 0);
}

// The cross-fade each group is playing, so a replacement that animates its own
// change can stop it (settleFadeSwap).
const running = new Map<string, readonly Animation[]>();

function crossFade(group: string, incoming: HTMLElement) {
  // Development's strict-mode remount of the same element is not a state change.
  if (leaving.get(group)?.source === incoming) return;
  const entry = takeLeavingCopy(leaving, group, modeSwitchCrossfadeRunning());
  if (!entry) return;
  if (window.matchMedia(REDUCED_MOTION).matches) return;
  const duration = motionDurationMs();
  const easing = "cubic-bezier(0.2, 0, 0, 1)";
  document.body.append(entry.copy);
  const out = entry.copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing });
  void out.finished.then(
    () => entry.copy.remove(),
    () => entry.copy.remove(),
  );
  // Both sides fade in place; nothing rises.
  const into = incoming.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing });
  const animations = [out, into];
  running.set(group, animations);
  void into.finished.then(
    () => {
      if (running.get(group) === animations) running.delete(group);
    },
    () => undefined,
  );
}

/**
 * Stops a group's cross-fade that just started, for a replacement that
 * animates its content change itself, including when a new draft replaces
 * the old hero during the same fade.
 */
export function settleFadeSwap(group: string) {
  const animations = running.get(group);
  if (!animations) return;
  running.delete(group);
  for (const animation of animations) animation.cancel();
}

/** Fades the copy a removed item left behind, for a replacement that has nothing to show there. */
function fadeOutLeaving(group: string) {
  const entry = takeLeavingCopy(leaving, group, modeSwitchCrossfadeRunning());
  if (!entry) return;
  if (window.matchMedia(REDUCED_MOTION).matches) return;
  document.body.append(entry.copy);
  const out = entry.copy.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: motionDurationMs(),
    easing: "cubic-bezier(0.2, 0, 0, 1)",
  });
  void out.finished.then(
    () => entry.copy.remove(),
    () => entry.copy.remove(),
  );
}

function SwapItem({
  group,
  className,
  children,
}: {
  group: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    crossFade(group, element);
    return () => captureLeavingCopy(group, element);
  }, [group]);
  return (
    <span ref={ref} className={cn("inline-block", className)}>
      {children}
    </span>
  );
}

/**
 * Content for one named slot of a screen that cross-fades when `swapKey` changes:
 * the old copy fades out where it was while the new one fades in and rises. It
 * also works when the screen itself remounts, as a new draft does, because the
 * leaving copy is handed over through `group`. Opacity and transform only;
 * reduced motion snaps; nothing animates the first time a screen paints.
 */
export function FadeSwap({
  group,
  swapKey,
  className,
  children,
}: {
  group: string;
  swapKey: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <SwapItem key={swapKey} group={group} {...(className ? { className } : {})}>
      {children}
    </SwapItem>
  );
}

// What the screen that is being replaced shows right now, by slot. A new draft renders before
// the old one unmounts, so it can start from the old state and animate to its own.
const live = new Map<string, { readonly owner: object; readonly value: boolean }>();

/**
 * What the replaced screen showed in a slot, or undefined when this screen paints
 * on its own. A mode switch (Chats to Work, say) crossfades whole frames, so the
 * new mode opens in its final layout: its strip must not grow in from the Chats
 * composer that had none.
 */
function replacedValue(key: string): boolean | undefined {
  return modeSwitchCrossfadeRunning() ? undefined : live.get(key)?.value;
}

function useLiveValue(key: string, value: boolean): [object, boolean | undefined] {
  const [owner] = useState(() => ({}));
  const [replaced] = useState(() => replacedValue(key));
  useLayoutEffect(() => {
    live.set(key, { owner, value });
  }, [key, owner, value]);
  useLayoutEffect(
    () => () => {
      if (live.get(key)?.owner === owner) live.delete(key);
    },
    [key, owner],
  );
  return [owner, replaced];
}

/**
 * Whether the composer shell shows the strip's extension. It follows `visible` one
 * frame late so the shell's silhouette animates, and starts from where the screen
 * it replaces left off when a new draft takes its place.
 */
export function useExtendedAfterFrame(visible: boolean): boolean {
  const [extended, setExtended] = useState(() => replacedValue("composer-extension") ?? visible);
  useLiveValue("composer-extension", extended);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setExtended(visible));
    return () => cancelAnimationFrame(frame);
  }, [visible]);
  return extended;
}

/**
 * Collapses to zero height and fades when `open` clears, and grows back when it
 * returns, so a strip that appears under the composer does not make it jump.
 * The closing content stays mounted until the collapse ends, and
 * `onLingerChange` reports that so the caller can hold what depends on it. A
 * strip its replacement screen no longer has fades out where it was. Reduced
 * motion mounts and unmounts at once.
 */
export function CollapsePresence({
  open,
  onLingerChange,
  children,
}: {
  open: boolean;
  onLingerChange?: (lingering: boolean) => void;
  children: ReactNode;
}) {
  const reducedMotion = useMediaQuery(REDUCED_MOTION);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  useLayoutEffect(() => {
    openRef.current = open;
  }, [open]);
  const [mounted, setMounted] = useState(open);
  const [previousOpen, setPreviousOpen] = useState(open);
  const [moving, setMoving] = useState(false);
  // Replacing a screen whose strip was closed: mount collapsed and grow.
  const [enteredOpen, setEnteredOpen] = useState(
    () => open && replacedValue("composer-strip") !== false,
  );
  useLiveValue("composer-strip", open);
  const held = useLastPresent(open ? children : null);
  if (open && !mounted) setMounted(true);
  if (previousOpen !== open) {
    setPreviousOpen(open);
    setMoving(true);
    if (!open) setEnteredOpen(false);
  }
  const lingering = mounted && !open && !reducedMotion;
  useLayoutEffect(() => {
    onLingerChange?.(lingering);
  }, [lingering, onLingerChange]);
  // A strip the replaced screen had and this one does not fades out where it was.
  useLayoutEffect(() => {
    if (!openRef.current) fadeOutLeaving("composer-strip");
    return () => {
      if (openRef.current && wrapperRef.current) {
        captureLeavingCopy("composer-strip", wrapperRef.current);
      }
    };
  }, []);
  // Grow from zero: mount collapsed, open on the next frame.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => setEnteredOpen(true));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  if (reducedMotion) return open ? children : null;
  if (!mounted) return null;
  const expanded = open && enteredOpen;
  return (
    <div
      ref={wrapperRef}
      inert={!open}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-(--motion-duration-base) ease-standard",
        expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") {
          return;
        }
        setMoving(false);
        if (!open) setMounted(false);
      }}
    >
      {/* Clipped only while moving: the strip's own shadow and seam overflow its box at rest. */}
      <div className={cn("min-h-0", (moving || !expanded) && "overflow-hidden")}>
        {open ? children : held}
      </div>
    </div>
  );
}

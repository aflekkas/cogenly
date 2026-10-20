import { useEffect, useState, type ReactNode } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";

import { useLastPresent } from "../ui/overlay-presence";

/**
 * True once the first paint has happened. Enter motion keys off it so a screen
 * that opens already in its state does not animate in.
 */
function useAfterFirstPaint() {
  const [armed, setArmed] = useState(false);
  useEffect(() => setArmed(true), []);
  return armed;
}

/**
 * Content that fades and rises in when `swapKey` changes: a heading or line that
 * names the current state. Transform and opacity only; reduced motion snaps.
 */
export function FadeSwap({
  swapKey,
  className,
  children,
}: {
  swapKey: string;
  className?: string;
  children: ReactNode;
}) {
  const armed = useAfterFirstPaint();
  return (
    <span
      key={swapKey}
      className={cn(
        "inline-block motion-safe:transition-[opacity,translate] motion-safe:duration-(--motion-duration-base) motion-safe:ease-standard",
        armed && "motion-safe:starting:translate-y-1 motion-safe:starting:opacity-0",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Collapses to zero height and fades when `open` clears, and grows back when it
 * returns, so a strip that appears under the composer does not make it jump.
 * The closing content stays mounted until the collapse ends. Reduced motion
 * mounts and unmounts at once.
 */
export function CollapsePresence({ open, children }: { open: boolean; children: ReactNode }) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const armed = useAfterFirstPaint();
  const [mounted, setMounted] = useState(open);
  const [previousOpen, setPreviousOpen] = useState(open);
  const [moving, setMoving] = useState(false);
  const held = useLastPresent(open ? children : null);
  if (open && !mounted) setMounted(true);
  if (previousOpen !== open) {
    setPreviousOpen(open);
    setMoving(armed);
  }
  if (reducedMotion) return open ? children : null;
  if (!mounted) return null;
  return (
    <div
      inert={!open}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-(--motion-duration-base) ease-standard",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        armed && open && "starting:grid-rows-[0fr] starting:opacity-0",
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
      <div className={cn("min-h-0", (moving || !open) && "overflow-hidden")}>
        {open ? children : held}
      </div>
    </div>
  );
}

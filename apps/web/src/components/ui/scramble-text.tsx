import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { cn } from "~/lib/utils";
import {
  initScrambleCells,
  resolveScrambleCells,
  stepScrambleCells,
  type ScrambleCell,
} from "./scrambleText.logic";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
/** Matches --motion-duration-base: the last characters finish fading in before the plain text returns. */
const SETTLE_FADE_MS = 220;

function subscribeReducedMotion(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readReducedMotion() {
  return typeof window !== "undefined" && !!window.matchMedia?.(REDUCED_MOTION_QUERY).matches;
}

/** Longer of two strings, by character count: the width the frame must hold. */
function longer(a: string, b: string) {
  return Array.from(a).length >= Array.from(b).length ? a : b;
}

interface ScrambleFrame {
  readonly cells: readonly ScrambleCell[];
  /** Invisible text that holds the box at the widest text in play. */
  readonly lock: string;
  /** What assistive tech hears: the old text while pending, then the new. */
  readonly settled: string;
}

/**
 * Text that decodes itself. While `scrambling` is on, the text dims and about
 * a third of its characters gently flicker to look-alike glyphs, each on its
 * own slow clock, so it stays legible. When `scrambling` turns off, the (new)
 * `text` settles in left to right over about 800ms, each character fading in.
 *
 * The characters sit over an invisible copy of the widest text in play, so
 * the box keeps a stable width. The animated layer is hidden from assistive
 * tech; with `announce`, an off-screen copy announces only the final text.
 * Under reduced motion the current text pulses gently instead, then the new
 * text fades in. At rest it renders plain text and runs no animation frames.
 */
export function ScrambleText({
  text,
  scrambling,
  announce = false,
}: {
  text: string;
  scrambling: boolean;
  /** Announce the final text politely once it lands (never the scramble). */
  announce?: boolean;
}) {
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    readReducedMotion,
    () => false,
  );
  const [frame, setFrame] = useState<ScrambleFrame | null>(null);
  // Reduced motion only: the new text fades in after a regeneration, not on mount.
  const [fadeInText, setFadeInText] = useState(false);
  const textRef = useRef(text);
  const lockRef = useRef(text);
  const cellsRef = useRef<ScrambleCell[]>([]);
  const wasScramblingRef = useRef(false);
  useLayoutEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    if (reducedMotion) {
      if (wasScramblingRef.current && !scrambling) setFadeInText(true);
      wasScramblingRef.current = scrambling;
      setFrame(null);
      return;
    }
    let rafId = 0;

    if (scrambling) {
      if (!wasScramblingRef.current) {
        lockRef.current = textRef.current;
        cellsRef.current = initScrambleCells(textRef.current, performance.now(), Math.random);
        setFrame({ cells: cellsRef.current, lock: lockRef.current, settled: lockRef.current });
      }
      wasScramblingRef.current = true;
      const tick = (now: number) => {
        const source = textRef.current;
        const step = stepScrambleCells(cellsRef.current, source, now, Math.random);
        if (step.changed) {
          cellsRef.current = step.cells;
          setFrame({
            cells: step.cells,
            lock: longer(lockRef.current, source),
            settled: lockRef.current,
          });
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(rafId);
    }

    if (!wasScramblingRef.current) return;
    wasScramblingRef.current = false;
    let startedAt: number | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const tick = (now: number) => {
      startedAt ??= now;
      const target = textRef.current;
      const step = resolveScrambleCells(
        cellsRef.current,
        lockRef.current,
        target,
        now - startedAt,
        now,
        Math.random,
      );
      cellsRef.current = step.cells;
      if (step.changed || step.done) {
        setFrame({ cells: step.cells, lock: longer(lockRef.current, target), settled: target });
      }
      if (step.done) {
        settleTimer = setTimeout(() => setFrame(null), SETTLE_FADE_MS);
        return;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(settleTimer);
    };
  }, [reducedMotion, scrambling]);

  const settledText = scrambling ? (frame?.settled ?? text) : text;
  const liveCopy = announce ? (
    <span className="sr-only" aria-live={scrambling ? "off" : "polite"}>
      {settledText}
    </span>
  ) : null;

  if (reducedMotion) {
    return (
      <span>
        <span
          aria-hidden={announce || undefined}
          // Keyed on the text so the new title fades in when it lands.
          key={text}
          className={cn(
            fadeInText &&
              "transition-opacity duration-(--motion-duration-base) ease-standard starting:opacity-0",
            scrambling && "animate-pulse",
          )}
        >
          {text}
        </span>
        {liveCopy}
      </span>
    );
  }

  if (frame === null) {
    return (
      <span>
        <span aria-hidden={announce || undefined}>{text}</span>
        {liveCopy}
      </span>
    );
  }

  return (
    <span>
      <span aria-hidden className="inline-grid">
        <span className="invisible col-start-1 row-start-1">{frame.lock}</span>
        <span className="col-start-1 row-start-1">
          {frame.cells.map((cell, index) => (
            <span
              // Index keys keep each character's element, so its fade runs.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              className={cn(
                "transition-[opacity,color] duration-(--motion-duration-base) ease-standard",
                cell.scrambled
                  ? "text-muted-foreground opacity-50"
                  : scrambling
                    ? "text-muted-foreground"
                    : "opacity-100",
              )}
            >
              {cell.char}
            </span>
          ))}
        </span>
      </span>
      {liveCopy ?? <span className="sr-only">{settledText}</span>}
    </span>
  );
}

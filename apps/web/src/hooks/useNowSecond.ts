import { useEffect, useEffectEvent, useSyncExternalStore } from "react";

/** One module-level timer, aligned to second boundaries, drives every running
    elapsed label, so they all update in the same frame. Labels that tick
    through DOM writes subscribe with `useSecondTick`; ones that render the
    time read `useNowSecond`. */

function currentSecond(): number {
  return Math.floor(Date.now() / 1_000) * 1_000;
}

let nowSecond = currentSecond();
let timerId: number | null = null;
let timerIsInterval = false;
const listeners = new Set<() => void>();

function tick(): void {
  nowSecond = currentSecond();
  for (const listener of listeners) listener();
}

function startTimer(): void {
  // Align to the next second boundary, then tick every second. Ticks re-read
  // the clock, so a throttled or late timer self-corrects when it fires.
  timerIsInterval = false;
  timerId = window.setTimeout(
    () => {
      tick();
      timerIsInterval = true;
      timerId = window.setInterval(tick, 1_000);
    },
    1_000 - (Date.now() % 1_000),
  );
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) startTimer();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timerId !== null) {
      if (timerIsInterval) window.clearInterval(timerId);
      else window.clearTimeout(timerId);
      timerId = null;
    }
  };
}

function getSnapshot(): number {
  // With no timer running the stored second may be stale; re-read it so a
  // fresh mount renders the current second instead of waiting for a tick.
  if (timerId === null) nowSecond = currentSecond();
  return nowSecond;
}

const subscribeNever = () => () => {};

/** The current time in milliseconds, re-rendering once a second while `active`. */
export function useNowSecond(active = true): number {
  return useSyncExternalStore(active ? subscribe : subscribeNever, getSnapshot, getSnapshot);
}

/** Runs `onTick` on every shared second while `active`, without re-rendering. */
export function useSecondTick(active: boolean, onTick: () => void): void {
  const handleTick = useEffectEvent(onTick);
  useEffect(() => {
    if (!active) return;
    return subscribe(handleTick);
  }, [active]);
}

import { flushSync } from "react-dom";

/**
 * The one motion of a mode switch (Chats, Work, Agents, Projects, and
 * Settings): a pure crossfade of the whole window, opacity only.
 * Nothing moves. It is a same-document view transition of the root: the old
 * frame fades out while the new one fades in, blended with plus-lighter, so
 * whatever is the same in both modes (the rail, the search bar, the header)
 * stays perfectly still and only what changed fades. Instant under reduced
 * motion. See the `data-mode-switch-transition` rules in index.css. Switching
 * the sidebar layout (top or bottom) uses the same crossfade.
 *
 * The new frame is captured once the main pane's content for the new mode has
 * committed (`settleModeSwitchMainPane`), often a navigation or two later, or
 * after MAIN_PANE_WAIT_MS at the latest; until then the old frame stays on
 * screen, so there is never a blank frame or a cut in the middle of the fade.
 */

/** The main pane's content for a picked mode lands within this long, or the fade runs without it. */
export const MAIN_PANE_WAIT_MS = 400;
const TRANSITION_ATTRIBUTE = "modeSwitchTransition";

interface ModeSwitchViewTransition {
  readonly finished: Promise<void>;
}
type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => Promise<void>) => ModeSwitchViewTransition;
};

let settlePendingMainPane: (() => void) | null = null;
let activeTransition: ModeSwitchViewTransition | null = null;

function crossfadeAvailable(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  if (typeof (document as ViewTransitionDocument).startViewTransition !== "function") return false;
  if (document.visibilityState === "hidden") return false;
  return !(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

/** Resolves on `settleModeSwitchMainPane`, or after `timeoutMs`. */
export function waitForModeSwitchMainPane(timeoutMs: number = MAIN_PANE_WAIT_MS): Promise<void> {
  // A newer switch takes over: the older one stops waiting.
  settlePendingMainPane?.();
  return new Promise<void>((resolve) => {
    const settle = () => {
      if (settlePendingMainPane === settle) settlePendingMainPane = null;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(settle, timeoutMs);
    settlePendingMainPane = settle;
  });
}

/**
 * The main pane's content for the switched-to mode has committed. Call from a
 * layout effect (before paint), so the crossfade captures it as the new frame.
 */
export function settleModeSwitchMainPane(): void {
  settlePendingMainPane?.();
}

/**
 * Runs a mode switch inside the crossfade. `update` changes the state (it runs
 * in flushSync, so the list column commits at once) and returns true when the
 * main pane changes too, which the fade then waits for. Runs `update` directly
 * under reduced motion or without view transitions.
 */
export function crossfadeModeSwitch(update: () => boolean): void {
  if (!crossfadeAvailable()) {
    update();
    return;
  }
  const root = document.documentElement;
  // Set before the old frame is captured, so its fade already uses these rules.
  root.dataset[TRANSITION_ATTRIBUTE] = "";
  try {
    const transition = (document as ViewTransitionDocument).startViewTransition!(async () => {
      let awaitsMainPane = false;
      flushSync(() => {
        awaitsMainPane = update();
      });
      if (awaitsMainPane) await waitForModeSwitchMainPane();
    });
    activeTransition = transition;
    const clear = () => {
      if (activeTransition !== transition) return;
      activeTransition = null;
      delete root.dataset[TRANSITION_ATTRIBUTE];
    };
    transition.finished.then(clear, clear);
  } catch {
    if (activeTransition === null) delete root.dataset[TRANSITION_ATTRIBUTE];
    update();
  }
}

/** True while a mode switch's crossfade runs, so nothing inside it plays a fade of its own. */
export function modeSwitchCrossfadeRunning(): boolean {
  return activeTransition !== null;
}

/** A motion token, falling back when the stylesheet has not loaded. */
const DURATION_FALLBACK_MS = { fast: 150, base: 220 } as const;

/**
 * Web Animations timing from the shared `--motion-duration-*` and
 * `--motion-ease-standard` tokens, for settings motion that is scripted
 * because the start value only exists before the change commits.
 */
export function settingsMotionTiming(duration: keyof typeof DURATION_FALLBACK_MS) {
  const root = getComputedStyle(document.documentElement);
  return {
    duration:
      Number.parseFloat(root.getPropertyValue(`--motion-duration-${duration}`)) ||
      DURATION_FALLBACK_MS[duration],
    easing: root.getPropertyValue("--motion-ease-standard").trim() || "ease-out",
  };
}

/**
 * Reduced motion from the OS setting or Appearance's Reduce motion, read when
 * a scripted motion starts. Reduced keeps the opacity fade and drops height.
 */
export { readReducedMotion as prefersReducedMotion } from "../../appearancePreferences";

/** False in environments without Web Animations (tests). */
export function canAnimate(element: Element): boolean {
  return typeof element.animate === "function";
}

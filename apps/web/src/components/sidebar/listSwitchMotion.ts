const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const BLUR_RADIUS = "6px";

/**
 * Plays the enter motion for a sidebar list a count-bar filter just swapped in
 * (Work's shelves, Agents' filters): the new list blur-fades in place, in the
 * style of Magic UI's Blur Fade. The old list is gone at once, so only the
 * arrival moves. Call it from a layout effect after the swap commits. Reduced
 * motion keeps the opacity fade and drops the blur.
 */
export function playListSwitchMotion(element: HTMLElement | null) {
  if (!element) return;
  const style = getComputedStyle(element);
  const keyframes = window.matchMedia(REDUCED_MOTION_QUERY).matches
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [
        { opacity: 0, filter: `blur(${BLUR_RADIUS})` },
        { opacity: 1, filter: "blur(0)" },
      ];
  // A Web Animation leaves no inline style behind once it finishes.
  element.animate(keyframes, {
    duration: Number.parseFloat(style.getPropertyValue("--motion-duration-base")) || 220,
    easing: style.getPropertyValue("--ease-out").trim() || "ease-out",
  });
}

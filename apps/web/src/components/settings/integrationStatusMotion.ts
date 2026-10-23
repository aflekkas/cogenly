/** Fades a changed status without animating initial mount or repeated snapshots. */
export function createIntegrationStatusFade(element: HTMLElement) {
  let previous: string | undefined;
  let animation: Animation | undefined;
  return {
    update(status: string) {
      if (status === previous) return;
      const changed = previous !== undefined;
      previous = status;
      if (!changed) return;
      animation?.cancel();
      const tokens = getComputedStyle(element);
      // Opacity alone is also the reduced-motion path.
      animation = element.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: Number.parseFloat(tokens.getPropertyValue("--motion-duration-base")),
        easing: tokens.getPropertyValue("--ease-out").trim(),
      });
    },
    dispose() {
      animation?.cancel();
    },
  };
}

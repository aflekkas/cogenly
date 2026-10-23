import type { ComponentProps } from "react";

/**
 * The app's stop mark: a small rounded square inset in its box, the composer
 * stop button's glyph. Every Stop control uses it; it sizes like an icon, so a
 * button's own icon size applies.
 */
export function StopGlyph(props: ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" {...props}>
      <rect x="2" y="2" width="8" height="8" rx="1.5" />
    </svg>
  );
}

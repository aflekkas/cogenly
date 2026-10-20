import { MorphIcon as BaseMorphIcon, type MorphIconProps } from "morphicons/react";

// Critically damped (damping = 2√stiffness): as quick as the library's snappy
// preset, without its overshoot, so icon swaps settle like the app's
// ease-standard transitions.
const MORPH_ICON_SPRING = { stiffness: 400, damping: 40 };

/** Renders `lucide` icon data and morphs between shapes when `icon` changes. */
export function MorphIcon({
  reducedMotion = "user",
  spring = MORPH_ICON_SPRING,
  ...props
}: MorphIconProps) {
  return <BaseMorphIcon reducedMotion={reducedMotion} spring={spring} {...props} />;
}

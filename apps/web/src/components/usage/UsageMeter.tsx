import { type CSSProperties, useEffect, useState } from "react";

import {
  type UsageMeterMode,
  USAGE_METER_MODES,
  useAppearancePreferences,
} from "../../appearancePreferences";
import { cn } from "../../lib/utils";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

/** Matches `--motion-duration-base`, which the transition classes below use. */
const SWITCH_MOTION_MS = 220;

const MODE_LABELS: Record<UsageMeterMode, string> = {
  remaining: "Remaining",
  used: "Used",
};

/**
 * Whether usage bars fill with quota left or quota used, and whether they are
 * in the middle of the glide a switch gives them. The glide is never on at
 * mount, and it ends on its own, so a refresh that moves a bar snaps like
 * any other data change: only the user's switch animates.
 */
export function useUsageMeter(): { readonly mode: UsageMeterMode; readonly switching: boolean } {
  const { preferences } = useAppearancePreferences();
  const mode = preferences.usageMeter;
  const [seen, setSeen] = useState(mode);
  // The mode the glide is heading to; each switch restarts the timer.
  const [switchingTo, setSwitchingTo] = useState<UsageMeterMode | null>(null);
  // Set during render so the first frame with the new widths already carries
  // the transition; an effect would turn it on one frame too late.
  if (seen !== mode) {
    setSeen(mode);
    setSwitchingTo(mode);
  }
  useEffect(() => {
    if (switchingTo === null) return;
    const timer = setTimeout(() => setSwitchingTo(null), SWITCH_MOTION_MS);
    return () => clearTimeout(timer);
  }, [switchingTo]);
  return { mode, switching: switchingTo !== null };
}

const SWITCH_TRANSITION =
  "duration-(--motion-duration-base) ease-standard motion-reduce:transition-none";

/**
 * A horizontal slice of a meter, `size` percent wide starting `start` percent
 * in. Every bar fill in the usage views is one of these, so they animate a
 * switch the same way.
 */
export function MeterSpan({
  start = 0,
  size,
  switching,
  className,
  style,
}: {
  readonly start?: number;
  readonly size: number;
  readonly switching: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
}) {
  return (
    <div
      aria-hidden
      className={cn(switching && `transition-[left,width] ${SWITCH_TRANSITION}`, className)}
      style={{ ...style, left: `${start}%`, width: `${size}%` }}
    />
  );
}

/** The even-pace hairline, `position` percent along the bar. */
export function MeterMarker({
  position,
  switching,
  className,
}: {
  readonly position: number;
  readonly switching: boolean;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(switching && `transition-[left] ${SWITCH_TRANSITION}`, className)}
      style={{ left: `${position}%` }}
    />
  );
}

/**
 * The remaining / used switch. One control for Settings and the Usage page, so
 * the two cannot drift apart.
 */
export function UsageMeterModeToggle() {
  const { preferences, update } = useAppearancePreferences();
  return (
    <ToggleGroup
      aria-label="Usage meters"
      variant="segmented"
      value={[preferences.usageMeter]}
      onValueChange={(next) => {
        const picked = USAGE_METER_MODES.find((mode) => mode === next[0]);
        if (picked !== undefined) update({ usageMeter: picked });
      }}
    >
      {USAGE_METER_MODES.map((mode) => (
        <Toggle key={mode} value={mode}>
          {MODE_LABELS[mode]}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

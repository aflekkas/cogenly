import { ArrowUpIcon, CheckIcon } from "lucide-react";
import { useState } from "react";

import {
  ACCENT_COLORS,
  DEFAULT_APPEARANCE_PREFERENCES,
  useAppearancePreferences,
  type AccentColor,
} from "../../appearancePreferences";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const ACCENT_COLOR_LABELS: Record<AccentColor, string> = {
  orange: "Orange",
  blue: "Blue",
  violet: "Violet",
  green: "Green",
  pink: "Pink",
  teal: "Teal",
  amber: "Amber",
  red: "Red",
};

// The Mac app mirrors the accent into its Dock icon (appearancePreferences.ts).
const DOCK_FOLLOWS_ACCENT = isElectron && window.desktopBridge?.getClientPlatform?.() === "darwin";

/**
 * Settings → Appearance → Accent color. Each swatch is a small pixel tile in
 * its accent, like the composer's send tile, and the strip under the row
 * shows the send tile, a brand button and a highlight in the accent the
 * pointer (or keyboard focus) is on, so a choice can be seen before it is
 * made. Only a click commits. Swatches and the strip scope the accent with
 * `data-accent-preview` (index.css), so nothing else on the page changes.
 */
export function AccentColorSettingRow() {
  const { preferences, update } = useAppearancePreferences();
  const [previewed, setPreviewed] = useState<AccentColor | null>(null);
  const shown = previewed ?? preferences.accent;
  return (
    <SettingsRow
      {...searchableSetting("accent-color")}
      description={
        DOCK_FOLLOWS_ACCENT
          ? "The color of send buttons, highlights, other accents and the Dock icon."
          : "The color of send buttons, highlights and other accents."
      }
      resetAction={
        preferences.accent !== DEFAULT_APPEARANCE_PREFERENCES.accent ? (
          <SettingResetButton
            label="accent color"
            onClick={() => update({ accent: DEFAULT_APPEARANCE_PREFERENCES.accent })}
          />
        ) : null
      }
      control={
        <div
          role="radiogroup"
          aria-label="Accent color"
          className="flex flex-wrap gap-1.5"
          onPointerLeave={() => setPreviewed(null)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setPreviewed(null);
          }}
        >
          {ACCENT_COLORS.map((accent) => (
            <AccentSwatch
              key={accent}
              accent={accent}
              selected={preferences.accent === accent}
              onPreview={() => setPreviewed(accent)}
              onSelect={() => update({ accent })}
            />
          ))}
        </div>
      }
    >
      <AccentPreviewStrip accent={shown} />
    </SettingsRow>
  );
}

function AccentSwatch(props: {
  readonly accent: AccentColor;
  readonly selected: boolean;
  readonly onPreview: () => void;
  readonly onSelect: () => void;
}) {
  const label = ACCENT_COLOR_LABELS[props.accent];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            role="radio"
            aria-checked={props.selected}
            aria-label={label}
            data-accent-preview={props.accent}
            onPointerEnter={props.onPreview}
            onFocus={props.onPreview}
            onClick={props.onSelect}
            // The send tile's mosaic on 3px cells (pixelButton.css), ringed
            // inside when chosen.
            className="pixel-button pixel-button-swatch flex size-6 cursor-pointer items-center justify-center rounded-tile text-white aria-checked:ring-2 aria-checked:ring-white/70 aria-checked:ring-inset"
          >
            <CheckIcon
              aria-hidden
              strokeWidth={3}
              className={cn(
                "size-3 transition-opacity duration-(--motion-duration-fast) ease-(--ease-out)",
                props.selected ? "opacity-100" : "opacity-0",
              )}
            />
          </button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * One layer per accent, stacked; the shown one fades in over the last, so a
 * sweep across the swatches crossfades instead of snapping. Decorative and
 * inert: nothing in it can be focused or clicked.
 */
function AccentPreviewStrip({ accent }: { readonly accent: AccentColor }) {
  return (
    <div aria-hidden inert className="mt-2 grid *:[grid-area:1/1]">
      {ACCENT_COLORS.map((layer) => (
        <div
          key={layer}
          data-accent-preview={layer}
          className={cn(
            "flex items-center gap-2.5 transition-opacity duration-(--motion-duration-fast) ease-(--ease-out)",
            layer === accent ? "opacity-100" : "opacity-0",
          )}
        >
          <span className="pixel-button flex size-7 items-center justify-center rounded-tile text-white shadow-xs shadow-black/24">
            <ArrowUpIcon aria-hidden strokeWidth={2.5} className="size-3.5" />
          </span>
          <Button variant="brand" size="xs" tabIndex={-1}>
            New agent
          </Button>
          <span className="rounded-md bg-brand-accent-tint px-1.5 py-0.5 text-xs font-medium text-brand-accent">
            Needs you
          </span>
        </div>
      ))}
    </div>
  );
}

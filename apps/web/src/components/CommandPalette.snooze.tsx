import type { TimestampFormat } from "@cogenly/contracts/settings";
import type { ReactNode } from "react";

import type { CommandPaletteGroup, CommandPaletteActionItem } from "./CommandPalette.logic";
import {
  resolveSnoozePresets,
  resolveTypedSnooze,
  snoozeWakeDescription,
  type SnoozePreset,
} from "./Sidebar.snooze";

/** The first group's value marks the palette's "Snooze thread…" view. */
export const SNOOZE_VIEW_VALUE = "snooze-thread";

export const SNOOZE_VIEW_PLACEHOLDER = "Snooze until… tomorrow 2pm, friday, in 2 days";

// What people type for each preset, so "tmrw" still finds Tomorrow.
const PRESET_ALIASES: Readonly<Record<SnoozePreset["id"], ReadonlyArray<string>>> = {
  hour: ["1h", "an hour"],
  "three-hours": ["3h"],
  evening: ["tonight", "evening"],
  tomorrow: ["tmrw", "tomorrow"],
  "next-week": ["next week", "monday"],
};

/**
 * The snooze view's rows: the menu's presets, led by the typed time when the
 * query reads as one the presets don't already offer. Enter takes the top row.
 */
export function buildSnoozeGroups(input: {
  readonly query: string;
  readonly now: Date;
  readonly timestampFormat: TimestampFormat;
  readonly icon: ReactNode;
  readonly snooze: (snoozedUntil: string) => Promise<void>;
}): ReadonlyArray<CommandPaletteGroup> {
  const presets = resolveSnoozePresets(input.now, input.timestampFormat);
  const query = input.query.trim();
  const typed = query.length === 0 ? null : resolveTypedSnooze(query, input.now);
  const typedIsPreset =
    typed !== null &&
    presets.some((preset) => Date.parse(preset.snoozedUntil) === Date.parse(typed));
  const typedItems: Array<CommandPaletteActionItem> =
    typed === null || typedIsPreset
      ? []
      : [
          {
            kind: "action",
            value: "snooze:typed",
            searchTerms: [query],
            title: `Snooze until ${snoozeWakeDescription(typed, input.now, input.timestampFormat)}`,
            icon: input.icon,
            run: () => input.snooze(typed),
          },
        ];
  return [
    {
      value: SNOOZE_VIEW_VALUE,
      label: "Snooze until",
      items: [
        ...typedItems,
        ...presets.map((preset): CommandPaletteActionItem => ({
          kind: "action",
          value: `snooze:${preset.id}`,
          searchTerms: [preset.label, ...PRESET_ALIASES[preset.id]],
          title: preset.label,
          description: preset.whenLabel,
          icon: input.icon,
          run: () => input.snooze(preset.snoozedUntil),
        })),
      ],
    },
  ];
}

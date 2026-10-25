import type { ProjectIconColor } from "@cogenly/contracts";

/**
 * The colors a project (folder) or repository icon can take: eight hues
 * spaced around the wheel, all Tailwind's 500 step so they hold up on light
 * and dark surfaces. The stored value is the name.
 */
export const PROJECT_PALETTE_COLORS = [
  "gray",
  "red",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const satisfies ReadonlyArray<ProjectIconColor>;

export type ProjectPaletteColor = (typeof PROJECT_PALETTE_COLORS)[number];

/**
 * Older palettes offered more hues, and stored values never change, so each
 * retired hue reads as its nearest remaining one wherever it is shown.
 * The contract still decodes every old name.
 */
const RETIRED_PROJECT_COLORS: Record<
  Exclude<ProjectIconColor, ProjectPaletteColor>,
  ProjectPaletteColor
> = {
  rose: "red",
  orange: "amber",
  yellow: "amber",
  lime: "green",
  emerald: "green",
  cyan: "teal",
  sky: "blue",
  indigo: "violet",
  purple: "violet",
  fuchsia: "pink",
};

const PALETTE_SET = new Set<string>(PROJECT_PALETTE_COLORS);

/** The palette color a stored value shows as: itself, its nearest remaining hue, or null when unknown. */
export function normalizeProjectColor(
  color: string | null | undefined,
): ProjectPaletteColor | null {
  if (color === null || color === undefined) return null;
  if (PALETTE_SET.has(color)) return color as ProjectPaletteColor;
  return (RETIRED_PROJECT_COLORS as Record<string, ProjectPaletteColor>)[color] ?? null;
}

export const PROJECT_ICON_COLORS: ReadonlyArray<{
  readonly value: ProjectPaletteColor;
  readonly label: string;
  /** Tailwind's 500 step as hex, for surfaces that cannot resolve CSS, like native menus. */
  readonly hex: `#${string}`;
  readonly className: string;
  readonly swatchClassName: string;
}> = [
  {
    value: "gray",
    label: "Gray",
    hex: "#6a7282",
    className: "text-gray-600 dark:text-gray-400",
    swatchClassName: "bg-gray-500",
  },
  {
    value: "red",
    label: "Red",
    hex: "#fb2c36",
    className: "text-red-600 dark:text-red-400",
    swatchClassName: "bg-red-500",
  },
  {
    value: "amber",
    label: "Amber",
    hex: "#fe9a00",
    className: "text-amber-600 dark:text-amber-400",
    swatchClassName: "bg-amber-500",
  },
  {
    value: "green",
    label: "Green",
    hex: "#00c950",
    className: "text-green-600 dark:text-green-400",
    swatchClassName: "bg-green-500",
  },
  {
    value: "teal",
    label: "Teal",
    hex: "#00bba7",
    className: "text-teal-600 dark:text-teal-400",
    swatchClassName: "bg-teal-500",
  },
  {
    value: "blue",
    label: "Blue",
    hex: "#2b7fff",
    className: "text-blue-600 dark:text-blue-400",
    swatchClassName: "bg-blue-500",
  },
  {
    value: "violet",
    label: "Violet",
    hex: "#8e51ff",
    className: "text-violet-600 dark:text-violet-400",
    swatchClassName: "bg-violet-500",
  },
  {
    value: "pink",
    label: "Pink",
    hex: "#f6339a",
    className: "text-pink-600 dark:text-pink-400",
    swatchClassName: "bg-pink-500",
  },
];

const PROJECT_ICON_COLOR_CLASSES = Object.fromEntries(
  PROJECT_ICON_COLORS.map(({ value, className }) => [value, className]),
) as Record<ProjectPaletteColor, string>;

/** Text color classes for a stored icon color; retired hues take their nearest remaining one. */
export function projectIconColorClassName(color: ProjectIconColor): string {
  return PROJECT_ICON_COLOR_CLASSES[normalizeProjectColor(color) ?? "gray"];
}

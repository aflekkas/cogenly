import type { AppearanceAccent } from "@t3tools/contracts";

/**
 * The accent presets (Settings → Appearance → Accent color): one base per
 * theme, as declared in apps/web/src/index.css and apps/web/index.html's boot
 * script (apps/web/src/accentPresets.sync.test.ts pins all three). Orange has
 * none: it is the brand ramp itself.
 */
export const ACCENT_PRESETS: Readonly<
  Record<Exclude<AppearanceAccent, "orange">, { readonly light: string; readonly dark: string }>
> = {
  blue: { light: "#2563eb", dark: "#4c8dff" },
  violet: { light: "#7c3aed", dark: "#9d6bff" },
  green: { light: "#15803d", dark: "#2fb565" },
  pink: { light: "#db2777", dark: "#f0559a" },
  teal: { light: "#0f766e", dark: "#1fb3a5" },
  amber: { light: "#b45309", dark: "#e8930c" },
  red: { light: "#c42b2b", dark: "#f04a4a" },
};

export type Rgb = readonly [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const packed = Number.parseInt(hex.replace(/^#/, ""), 16);
  return [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255];
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

const lum = ([r, g, b]: Rgb) => 0.3 * r + 0.59 * g + 0.11 * b;

/**
 * The CSS `color` blend mode (Compositing Level 1, SetLum/ClipColor): the
 * backdrop's lightness with the tint's hue and saturation. This is how the
 * composer's pixel tile recolors its ember sprites (pixelButton.css); the
 * boot splash (apps/web/index.html, an inline copy) and the accent Dock
 * icons (scripts/render-accent-dock-icons.ts) use the same math, so an
 * accent reads the same on all three. White stays white.
 */
export function colorBlend(backdrop: Rgb, tint: Rgb): Rgb {
  const delta = lum(backdrop) - lum(tint);
  const shifted: Rgb = [tint[0] + delta, tint[1] + delta, tint[2] + delta];
  const l = lum(shifted);
  const n = Math.min(...shifted);
  const x = Math.max(...shifted);
  const clip = (c: number) => {
    let value = c;
    if (n < 0) value = l + ((value - l) * l) / (l - n);
    if (x > 255) value = l + ((value - l) * (255 - l)) / (x - l);
    return Math.round(Math.min(255, Math.max(0, value)));
  };
  return [clip(shifted[0]), clip(shifted[1]), clip(shifted[2])];
}

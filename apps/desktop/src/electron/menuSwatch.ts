/**
 * Round color swatches for native menu items, such as a project's color
 * choices. Drawn as a premultiplied BGRA bitmap (the layout
 * `nativeImage.createFromBitmap` takes) so no image assets or encoders are
 * needed.
 */

/** The swatch's size in points; the bitmap is drawn at 2x. */
export const MENU_SWATCH_POINTS = 12;
export const MENU_SWATCH_SCALE = 2;

const HEX_COLOR = /^#([0-9a-f]{6})$/i;

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** `#rrggbb` to channels; anything else (a CSS variable, a name) is not drawable natively. */
export function parseHexColor(value: string | undefined): Rgb | null {
  const match = value === undefined ? null : HEX_COLOR.exec(value.trim());
  if (!match) return null;
  const hex = Number.parseInt(match[1]!, 16);
  return { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff };
}

/**
 * A filled, anti-aliased disc inset by one pixel per side, so it sits in the
 * menu's icon slot at the visual weight of a glyph. Returns the BGRA pixels
 * and their pixel size.
 */
export function drawSwatchBitmap(
  color: Rgb,
  points: number = MENU_SWATCH_POINTS,
  scale: number = MENU_SWATCH_SCALE,
): { readonly buffer: Buffer; readonly size: number } {
  const size = Math.round(points * scale);
  const buffer = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const radius = center - scale;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center);
      // One pixel of linear falloff at the edge for anti-aliasing.
      const coverage = Math.min(1, Math.max(0, radius - distance + 0.5));
      if (coverage === 0) continue;
      const offset = (y * size + x) * 4;
      buffer[offset] = Math.round(color.b * coverage);
      buffer[offset + 1] = Math.round(color.g * coverage);
      buffer[offset + 2] = Math.round(color.r * coverage);
      buffer[offset + 3] = Math.round(255 * coverage);
    }
  }
  return { buffer, size };
}

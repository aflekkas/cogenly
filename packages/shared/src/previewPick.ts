/**
 * Pure element-pick helpers shared by the server preview browser (which runs
 * the in-page capture) and, later, the web annotation pipeline.
 *
 * Limits mirror the desktop picker's: `htmlPreview` and `styles` cap at the
 * same 4000 chars `normalizeElementContextSelection` enforces, and truncation
 * uses the same `…` suffix so server and desktop picks read alike.
 */

import type {
  PickedElementPayload,
  PreviewAnnotationElementTarget,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
  PreviewAnnotationScreenshot,
} from "@cogenly/contracts";

/** Same storage cap the web pipeline enforces on desktop picks. */
export const PICK_HTML_PREVIEW_MAX_CHARS = 4000;
/** Same storage cap the web pipeline enforces on desktop picks. */
export const PICK_STYLES_MAX_CHARS = 4000;
export const PICK_TEXT_MAX_CHARS = 2000;
export const PICK_SELECTOR_MAX_CHARS = 500;
export const PICK_DOM_PATH_MAX_CHARS = 1000;
export const PICK_ACCESSIBLE_NAME_MAX_CHARS = 200;
export const PICK_ROLE_MAX_CHARS = 64;
export const PICK_TAG_MAX_CHARS = 64;
export const PICK_HOVER_LABEL_MAX_CHARS = 120;
export const PICK_ATTRIBUTE_NAME_MAX_CHARS = 64;
export const PICK_ATTRIBUTE_VALUE_MAX_CHARS = 500;
export const PICK_ATTRIBUTE_COUNT_MAX = 24;
export const PICK_PAGE_TITLE_MAX_CHARS = 512;
/** Breathing room around an element crop so the target reads in context. */
export const PICK_CROP_PADDING_PX = 12;
export const PICK_CROP_MAX_WIDTH = 1600;
export const PICK_CROP_MAX_HEIGHT = 1200;

const ELLIPSIS = "…";

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

/** Truncates like the web pipeline: newline-normalized, `…`-suffixed. */
export function truncatePickText(value: string, limit: number): string {
  const normalized = normalizeText(value);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}${ELLIPSIS}`;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export interface PickPoint {
  readonly x: number;
  readonly y: number;
}

export interface PickBox extends PickPoint {
  readonly width: number;
  readonly height: number;
}

/** Finite page point, or null when the client sent garbage. */
export function normalizePickPoint(value: unknown): PickPoint | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y } = value as Record<string, unknown>;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  return { x, y };
}

/** Finite box with a non-negative size, or null. */
export function normalizePickBox(value: unknown): PickBox | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  if (width < 0 || height < 0) return null;
  return { x, y, width, height };
}

/**
 * Screenshot clip for a viewport-relative box: padded, clamped into the
 * viewport, and capped so a huge element cannot produce a huge PNG. Null
 * when nothing usable remains.
 */
export function pickCropRect(
  box: PickBox,
  viewport: PickBox | { readonly width: number; readonly height: number },
  padding = PICK_CROP_PADDING_PX,
): PreviewAnnotationRect | null {
  const viewportWidth = viewport.width;
  const viewportHeight = viewport.height;
  if (!(viewportWidth > 0 && viewportHeight > 0)) return null;
  const pad = Math.max(0, Math.min(64, Math.floor(padding)));
  let x = Math.floor(Math.min(box.x, box.x + box.width) - pad);
  let y = Math.floor(Math.min(box.y, box.y + box.height) - pad);
  let width = Math.ceil(Math.abs(box.width)) + pad * 2;
  let height = Math.ceil(Math.abs(box.height)) + pad * 2;
  x = Math.max(0, x);
  y = Math.max(0, y);
  width = Math.min(width, Math.floor(viewportWidth) - x, PICK_CROP_MAX_WIDTH);
  height = Math.min(height, Math.floor(viewportHeight) - y, PICK_CROP_MAX_HEIGHT);
  if (width < 1 || height < 1) return null;
  return { x, y, width, height };
}

/**
 * True pixel size of a PNG from its IHDR, so the annotation reports what the
 * bytes hold rather than what the clip math assumed (zoom scales captures).
 */
export function parsePngDimensions(base64: string): PickBox | null {
  let bytes: Uint8Array;
  try {
    const binary = atob(base64);
    if (binary.length < 33) return null;
    bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  // PNG signature, then IHDR length (13) + type + width + height, big-endian.
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return null;
  }
  const width = (bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!;
  const height = (bytes[20]! << 24) | (bytes[21]! << 16) | (bytes[22]! << 8) | bytes[23]!;
  if (!(width > 0 && height > 0)) return null;
  return { x: 0, y: 0, width, height };
}

/**
 * Short tag/role/name for a hover highlight, e.g. `button "Buy It Now"`.
 * Display-only; the commit carries the structured fields.
 */
export function buildPickHoverLabel(input: {
  readonly tagName: string;
  readonly role?: string | null;
  readonly accessibleName?: string | null;
  readonly id?: string | null;
  readonly className?: string | null;
}): string | null {
  const tag = input.tagName.trim().toLowerCase().slice(0, PICK_TAG_MAX_CHARS);
  if (tag.length === 0) return null;
  const role = input.role?.trim().toLowerCase().slice(0, PICK_ROLE_MAX_CHARS) || null;
  const base = role && role !== tag ? `${role} (${tag})` : tag;
  const name = input.accessibleName?.trim().replace(/\s+/g, " ") || null;
  if (name) return truncatePickText(`${base} "${name}"`, PICK_HOVER_LABEL_MAX_CHARS);
  const id = input.id?.trim().split(/\s+/, 1)[0] || null;
  if (id) return truncatePickText(`${base} #${id}`, PICK_HOVER_LABEL_MAX_CHARS);
  const className = input.className?.trim().split(/\s+/, 1)[0] || null;
  if (className) return truncatePickText(`${base} .${className}`, PICK_HOVER_LABEL_MAX_CHARS);
  return base;
}

/**
 * Raw element capture as the in-page script returns it. Every string field is
 * untrusted page content; `buildPickedElementPayload` sanitizes it.
 */
export interface PickRawElementCapture {
  readonly tagName: unknown;
  readonly selector: unknown;
  readonly htmlPreview: unknown;
  readonly textContent: unknown;
  readonly role: unknown;
  readonly accessibleName: unknown;
  readonly attributes: unknown;
  readonly domPath: unknown;
  readonly rect: unknown;
  readonly styles: unknown;
}

const asTrimmedString = (value: unknown, limit: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return truncatePickText(trimmed, limit);
};

/** Drops non-string entries and caps names, values, and count. */
export function sanitizePickAttributes(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  const sanitized: Record<string, string> = {};
  for (const [name, entry] of entries) {
    if (Object.keys(sanitized).length >= PICK_ATTRIBUTE_COUNT_MAX) break;
    if (typeof entry !== "string") continue;
    const cleanName = name.trim().slice(0, PICK_ATTRIBUTE_NAME_MAX_CHARS);
    if (cleanName.length === 0 || cleanName in sanitized) continue;
    const cleanValue = entry.trim();
    if (cleanValue.length === 0) continue;
    sanitized[cleanName] = truncatePickText(cleanValue, PICK_ATTRIBUTE_VALUE_MAX_CHARS);
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

/**
 * Builds the element payload from a raw in-page capture, applying the same
 * sanitizing the desktop pipeline applies. Null when the capture has no tag.
 */
export function buildPickedElementPayload(
  raw: PickRawElementCapture,
  meta: { readonly pageUrl: string; readonly pageTitle: string | null; readonly pickedAt: string },
): PickedElementPayload | null {
  const tagName = typeof raw.tagName === "string" ? raw.tagName.trim().toLowerCase() : "";
  if (tagName.length === 0) return null;
  const pageUrl = meta.pageUrl.trim();
  if (pageUrl.length === 0) return null;
  const attributes = sanitizePickAttributes(raw.attributes);
  const role = asTrimmedString(raw.role, PICK_ROLE_MAX_CHARS);
  const accessibleName = asTrimmedString(raw.accessibleName, PICK_ACCESSIBLE_NAME_MAX_CHARS);
  const domPath = asTrimmedString(raw.domPath, PICK_DOM_PATH_MAX_CHARS);
  const textContent =
    typeof raw.textContent === "string" && raw.textContent.trim().length > 0
      ? truncatePickText(raw.textContent.trim(), PICK_TEXT_MAX_CHARS)
      : null;
  return {
    pageUrl,
    pageTitle: meta.pageTitle?.trim().slice(0, PICK_PAGE_TITLE_MAX_CHARS) || null,
    tagName: tagName.slice(0, PICK_TAG_MAX_CHARS),
    selector: asTrimmedString(raw.selector, PICK_SELECTOR_MAX_CHARS),
    htmlPreview:
      typeof raw.htmlPreview === "string"
        ? truncatePickText(raw.htmlPreview, PICK_HTML_PREVIEW_MAX_CHARS)
        : "",
    componentName: null,
    source: null,
    stack: [],
    styles:
      typeof raw.styles === "string" ? truncatePickText(raw.styles, PICK_STYLES_MAX_CHARS) : "",
    pickedAt: meta.pickedAt,
    ...(role === null ? {} : { role }),
    ...(accessibleName === null ? {} : { accessibleName }),
    ...(attributes === undefined ? {} : { attributes }),
    ...(domPath === null ? {} : { domPath }),
    ...(textContent === null ? {} : { textContent }),
  };
}

export interface PickAnnotationMeta {
  readonly id: string;
  readonly pageUrl: string;
  readonly pageTitle: string | null;
  readonly createdAt: string;
  readonly screenshot: PreviewAnnotationScreenshot | null;
}

/** Full annotation for one picked element, desktop-pick shaped. */
export function buildPickElementAnnotation(
  meta: PickAnnotationMeta,
  target: PreviewAnnotationElementTarget,
): PreviewAnnotationPayload {
  return {
    id: meta.id,
    pageUrl: meta.pageUrl,
    pageTitle: meta.pageTitle,
    comment: "",
    elements: [target],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: meta.screenshot,
    createdAt: meta.createdAt,
  };
}

/** Full annotation for a freeform region: a crop and no element. */
export function buildPickRegionAnnotation(
  meta: PickAnnotationMeta,
  region: { readonly id: string; readonly rect: PreviewAnnotationRect },
): PreviewAnnotationPayload {
  return {
    id: meta.id,
    pageUrl: meta.pageUrl,
    pageTitle: meta.pageTitle,
    comment: "",
    elements: [],
    regions: [region],
    strokes: [],
    styleChanges: [],
    screenshot: meta.screenshot,
    createdAt: meta.createdAt,
  };
}

import {
  COMPOSER_CONTEXT_ELEMENT_ATTRIBUTE_MAX_CHARS,
  COMPOSER_CONTEXT_ELEMENT_ATTRIBUTES_MAX_COUNT,
  COMPOSER_CONTEXT_ELEMENT_TEXT_MAX_CHARS,
  type PickedElementPayload,
  type PickedElementStackFrame,
  type PreviewAnnotationPayload,
} from "@cogenly/contracts";

const ELEMENT_CONTEXT_HTML_PREVIEW_LIMIT = 4000;
const ELEMENT_CONTEXT_STYLES_LIMIT = 4000;
const ELEMENT_CONTEXT_SHORT_LIMIT = 300;
const ELEMENT_CONTEXT_PATH_LIMIT = 1000;
const ELEMENT_CONTEXT_ATTRIBUTE_NAME_LIMIT = 100;

/**
 * Stable, persistable element selection captured from the in-app preview
 * browser. We deliberately keep the shape JSON-serializable so it can ride
 * through `localStorage` persistence, draft restoration, and transcript
 * snapshots without bespoke marshalling.
 */
export interface ElementContextSelection {
  /** Page URL where the element was picked. */
  pageUrl: string;
  /** Best-effort `<title>`. */
  pageTitle: string | null;
  /** Lowercase tag, e.g. `"button"`. */
  tagName: string;
  /** CSS selector; may be null when react-grab can't compute one. */
  selector: string | null;
  /** Truncated outer-HTML preview. */
  htmlPreview: string;
  /** Nearest React component display name, or null. */
  componentName: string | null;
  /** Source frame (file + line), or null when unavailable. */
  source: PickedElementStackFrame | null;
  /** Author CSS (no UA defaults). May be empty. */
  styles: string;
  /**
   * Server-browser picks add these; desktop picks leave them out. Optional
   * keys rather than `undefined` values, so the record still encodes as JSON.
   */
  role?: string | null;
  accessibleName?: string | null;
  attributes?: Readonly<Record<string, string>>;
  domPath?: string | null;
  textContent?: string;
}

function truncateString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

/**
 * Sanitize a payload coming back from the desktop bridge before it lands in
 * the composer draft. Trims/clamps every string field so we never persist a
 * 5MB outerHTML blob and silently break `localStorage`.
 */
export function normalizeElementContextSelection(
  raw: PickedElementPayload,
): ElementContextSelection | null {
  const pageUrl = raw.pageUrl.trim();
  const tagName = raw.tagName.trim().toLowerCase();
  if (pageUrl.length === 0 || tagName.length === 0) {
    return null;
  }
  const stackFrame = raw.source ?? raw.stack[0] ?? null;
  return {
    pageUrl,
    pageTitle: raw.pageTitle?.trim() ?? null,
    tagName,
    selector: raw.selector?.trim() || null,
    htmlPreview: truncateString(normalizeText(raw.htmlPreview), ELEMENT_CONTEXT_HTML_PREVIEW_LIMIT),
    componentName: raw.componentName?.trim() || null,
    source: stackFrame
      ? {
          functionName: stackFrame.functionName?.trim() || null,
          fileName: stackFrame.fileName?.trim() || null,
          lineNumber: stackFrame.lineNumber ?? null,
          columnNumber: stackFrame.columnNumber ?? null,
        }
      : null,
    styles: truncateString(normalizeText(raw.styles), ELEMENT_CONTEXT_STYLES_LIMIT),
    ...optionalText("role", raw.role, ELEMENT_CONTEXT_SHORT_LIMIT),
    ...optionalText("accessibleName", raw.accessibleName, ELEMENT_CONTEXT_SHORT_LIMIT),
    ...optionalText("domPath", raw.domPath, ELEMENT_CONTEXT_PATH_LIMIT),
    ...normalizeAttributes(raw.attributes),
    ...normalizeTextContent(raw.textContent),
  };
}

function optionalText<K extends "role" | "accessibleName" | "domPath">(
  key: K,
  value: string | null | undefined,
  limit: number,
): Partial<Record<K, string>> {
  const trimmed = value?.trim();
  return trimmed ? ({ [key]: truncateString(trimmed, limit) } as Record<K, string>) : {};
}

/** Keeps the first attributes by name, each clamped, so one huge `class` cannot crowd out the rest. */
function normalizeAttributes(attributes: Readonly<Record<string, string>> | undefined): {
  attributes?: Record<string, string>;
} {
  if (!attributes) return {};
  const entries = Object.entries(attributes)
    .map(([name, value]) => [name.trim(), value.trim()] as const)
    .filter(
      ([name, value]) =>
        name.length > 0 && name.length <= ELEMENT_CONTEXT_ATTRIBUTE_NAME_LIMIT && value.length > 0,
    )
    .slice(0, COMPOSER_CONTEXT_ELEMENT_ATTRIBUTES_MAX_COUNT)
    .map(([name, value]) => [
      name,
      truncateString(value, COMPOSER_CONTEXT_ELEMENT_ATTRIBUTE_MAX_CHARS),
    ]);
  return entries.length > 0 ? { attributes: Object.fromEntries(entries) } : {};
}

function normalizeTextContent(value: string | undefined): { textContent?: string } {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? { textContent: truncateString(text, COMPOSER_CONTEXT_ELEMENT_TEXT_MAX_CHARS) } : {};
}

/** Converts a saved element pick into the annotation shape used by current drafts. */
export function elementContextToPreviewAnnotation(
  element: ElementContextSelection,
  id: string,
  pickedAt: string,
): PreviewAnnotationPayload {
  return {
    id,
    pageUrl: element.pageUrl,
    pageTitle: element.pageTitle,
    comment: "",
    elements: [
      {
        id,
        element: { ...element, stack: [], pickedAt },
        rect: { x: 0, y: 0, width: 0, height: 0 },
      },
    ],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: null,
    createdAt: pickedAt,
  };
}

import {
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
  type ThemeAppearance,
  type ThemeColors,
} from "./themePalettes.ts";
import { HTML_RENDER_KIT_CSS, HTML_RENDER_KIT_SCRIPT } from "./htmlRenderKit.ts";

export { HTML_RENDER_KIT_GUIDE } from "./htmlRenderKit.ts";
import { EVENT_CODE_SHORTCUT_KEYS } from "./keybindings.ts";

/**
 * Agent-authored HTML pages ("HTML renders") are self-contained documents an
 * agent publishes into a thread with Cogenly's `html_render` MCP tool. The server
 * stores each one as a thread attachment with a small bootstrap injected into
 * its head; clients show it in a sandboxed iframe (web, desktop) or WebView
 * (mobile) and hand it the active theme as CSS custom properties.
 */

export const HTML_RENDER_TOOL_NAME = "html_render";
export const HTML_RENDER_MIN_HEIGHT = 80;
export const HTML_RENDER_MAX_HEIGHT = 2000;
export const HTML_RENDER_MAX_TITLE_LENGTH = 200;

/** What the `html_render` tool result carries so clients can show the page. */
export interface HtmlRenderReference {
  readonly attachmentId: string;
  readonly title: string;
  /** The agent's frame height in CSS pixels, and the cap on any measured height. */
  readonly height: number;
  /**
   * `[width, contentHeight]` pairs the server measured at publish, ascending by
   * width. Absent when the preview browser was not installed yet.
   */
  readonly heights?: ReadonlyArray<readonly [width: number, height: number]>;
  /**
   * The page's main blocks at the column width, measured with `heights`, so a
   * client can draw its loading skeleton in the page's shape. See
   * `encodeHtmlRenderOutline`.
   */
  readonly outline?: string;
}

/** Frame widths the server measures a page at, from phones to the wide chat setting. */
export const HTML_RENDER_MEASURE_WIDTHS = [320, 375, 430, 520, 640, 728, 860, 1000, 1144] as const;

/**
 * The reply column's frame width at the default chat width. Agents preview at
 * it, and it picks the measured height when a client cannot know its width.
 */
export const HTML_RENDER_COLUMN_WIDTH = 728;

const MAX_MEASURED_HEIGHTS = 24;

function readMeasuredHeights(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MEASURED_HEIGHTS) {
    return undefined;
  }
  const heights = value.flatMap((entry) =>
    Array.isArray(entry) &&
    entry.length === 2 &&
    Number.isInteger(entry[0]) &&
    entry[0] >= 1 &&
    entry[0] <= 10_000 &&
    typeof entry[1] === "number" &&
    Number.isFinite(entry[1])
      ? [[entry[0] as number, clampHtmlRenderHeight(entry[1])] as const]
      : [],
  );
  return heights.length === value.length
    ? [...heights].sort((left, right) => left[0] - right[0])
    : undefined;
}

export function readHtmlRenderReference(value: unknown): HtmlRenderReference | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { attachmentId, title, height, heights, outline } = value as Record<string, unknown>;
  if (
    typeof attachmentId !== "string" ||
    attachmentId.length === 0 ||
    attachmentId.length > 256 ||
    typeof title !== "string" ||
    typeof height !== "number" ||
    !Number.isFinite(height)
  ) {
    return undefined;
  }
  const measured = readMeasuredHeights(heights);
  return {
    attachmentId,
    title: title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML",
    height: clampHtmlRenderHeight(height),
    ...(measured === undefined ? {} : { heights: measured }),
    ...(measured !== undefined && typeof outline === "string" && OUTLINE_PATTERN.test(outline)
      ? { outline }
      : {}),
  };
}

/** Whether two references show the same page at the same sizes. */
export function htmlRenderReferencesEqual(left: HtmlRenderReference, right: HtmlRenderReference) {
  return (
    left.attachmentId === right.attachmentId &&
    left.title === right.title &&
    left.height === right.height &&
    left.outline === right.outline &&
    (left.heights ?? []).length === (right.heights ?? []).length &&
    (left.heights ?? []).every(
      ([width, height], index) =>
        right.heights?.[index]?.[0] === width && right.heights[index][1] === height,
    )
  );
}

// The taller of the heights measured at the nearest widths on each side. A
// breakpoint between two measured widths can make the page as tall as either.
function measuredHeight(heights: NonNullable<HtmlRenderReference["heights"]>, width: number) {
  const above = heights.findIndex(([measuredWidth]) => measuredWidth >= width);
  const high = above === -1 ? heights.length - 1 : above;
  const low = heights[high]![0] === width ? high : Math.max(0, high - 1);
  return Math.max(heights[low]![1], heights[high]![1]);
}

/**
 * The frame height for a page at a frame width. It is the page's own reported
 * `contentHeight` when the client has one, else the server's measurement for
 * that width. A page even a few pixels taller than its frame scrolls inside it
 * and takes the reader's scroll, so the frame fits the page. The agent's height
 * caps it only when it is below the page's height at the column width (the
 * agent asked for a scrolling frame) or when the page was never measured.
 */
export function htmlRenderFrameHeight(
  reference: HtmlRenderReference,
  width: number,
  contentHeight?: number,
) {
  const heights = reference.heights;
  if (heights === undefined || heights.length === 0) {
    return clampHtmlRenderHeight(Math.min(reference.height, contentHeight ?? reference.height));
  }
  const cap =
    measuredHeight(heights, HTML_RENDER_COLUMN_WIDTH) > reference.height
      ? reference.height
      : HTML_RENDER_MAX_HEIGHT;
  return clampHtmlRenderHeight(Math.min(cap, contentHeight ?? measuredHeight(heights, width)));
}

/**
 * One block of a page's outline: `text` with its line count, a `media` element
 * or solid shape, or a `table` with its row count.
 */
export interface HtmlRenderOutlineBox {
  readonly kind: "text" | "media" | "table";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly lines: number;
}

const OUTLINE_KINDS = { t: "text", m: "media", g: "table" } as const;
const OUTLINE_LETTERS = { text: "t", media: "m", table: "g" } as const;
// Coordinates travel in 4px units, which keeps the tool result an agent reads short.
const OUTLINE_UNIT = 4;
export const HTML_RENDER_OUTLINE_MAX_BOXES = 48;
// Sizes and line counts are never zero, so a client never divides by one.
const OUTLINE_BOX = "[tmg]\\d{1,4},\\d{1,4},[1-9]\\d{0,3},[1-9]\\d{0,3},[1-9]\\d{0,2}";
const OUTLINE_PATTERN = new RegExp(
  `^${OUTLINE_BOX}(?:;${OUTLINE_BOX}){0,${HTML_RENDER_OUTLINE_MAX_BOXES - 1}}$`,
);

/** Packs measured boxes, in CSS pixels at the column width, into an outline string. */
export function encodeHtmlRenderOutline(
  boxes: ReadonlyArray<HtmlRenderOutlineBox>,
): string | undefined {
  const unit = (value: number) => Math.min(9_999, Math.max(0, Math.round(value / OUTLINE_UNIT)));
  const encoded = boxes
    .slice(0, HTML_RENDER_OUTLINE_MAX_BOXES)
    .flatMap((box) =>
      unit(box.width) > 0 && unit(box.height) > 0
        ? [
            `${OUTLINE_LETTERS[box.kind]}${unit(box.x)},${unit(box.y)},${unit(box.width)},${unit(box.height)},${Math.min(999, Math.max(1, Math.round(box.lines)))}`,
          ]
        : [],
    )
    .join(";");
  return encoded === "" ? undefined : encoded;
}

/**
 * The outline's boxes in CSS pixels for a frame `width` wide, stretched to the
 * page's measured height there. Empty without an outline.
 */
export function htmlRenderOutlineBoxes(
  reference: HtmlRenderReference,
  width: number,
): ReadonlyArray<HtmlRenderOutlineBox> {
  const heights = reference.heights;
  if (reference.outline === undefined || heights === undefined || heights.length === 0) return [];
  const scaleX = width / HTML_RENDER_COLUMN_WIDTH;
  const scaleY = measuredHeight(heights, width) / measuredHeight(heights, HTML_RENDER_COLUMN_WIDTH);
  return reference.outline.split(";").map((entry) => {
    const [x = 0, y = 0, boxWidth = 0, boxHeight = 0, lines = 1] = entry
      .slice(1)
      .split(",")
      .map(Number);
    return {
      kind: OUTLINE_KINDS[entry[0] as keyof typeof OUTLINE_KINDS],
      x: x * OUTLINE_UNIT * scaleX,
      y: y * OUTLINE_UNIT * scaleY,
      width: boxWidth * OUTLINE_UNIT * scaleX,
      height: boxHeight * OUTLINE_UNIT * scaleY,
      lines,
    };
  });
}

/** A readable download name: the title without characters file systems reject. */
export function htmlRenderFileName(title: string) {
  const name = title
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return `${name || "Page"}.html`;
}

export function clampHtmlRenderHeight(height: number): number {
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)));
}

export interface HtmlRenderFonts {
  readonly sans: string;
  readonly mono: string;
}

export const HTML_RENDER_DEFAULT_FONTS: HtmlRenderFonts = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  // Concrete names only: some engines alias `ui-monospace` to the proportional UI font.
  mono: '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
};

/**
 * Fonts the server's headless browser lays pages out with. Arial-metric faces
 * stand in for the system UI fonts readers see, so measured heights and
 * preview screenshots wrap text close to how a client will.
 */
export const HTML_RENDER_MEASURE_FONTS: HtmlRenderFonts = {
  sans: '"Liberation Sans", Arimo, Arial, Helvetica, sans-serif',
  mono: '"Liberation Mono", Cousine, Menlo, Consolas, monospace',
};

/**
 * One subset of the app's self-hosted Inter (`@fontsource-variable/inter`,
 * committed under `fonts/`), as a frame loads it: an absolute URL on the
 * parent origin for clients, the headless browser's own page origin for
 * screenshots and measurements. A sandboxed frame has an opaque origin, so
 * the URL needs `Access-Control-Allow-Origin: *`, not same-origin access.
 */
export interface HtmlRenderFontFace {
  readonly url: string;
  readonly unicodeRange: string;
}

/** The family frames set once their font faces arrive. */
export const HTML_RENDER_APP_FONT_FAMILY = "Inter Variable";

/**
 * The Inter subsets frames load, with the unicode ranges from the font's own
 * CSS. Latin first, so a page using only it never downloads the extended file.
 * `file` names a woff2 under the shared package's `fonts/` export.
 */
export const HTML_RENDER_APP_FONT_FILES = [
  {
    file: "inter-latin-wght-normal.woff2",
    unicodeRange:
      "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  },
  {
    file: "inter-latin-ext-wght-normal.woff2",
    unicodeRange:
      "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
  },
] as const;

/** Where the headless browser serves the app font from on its page origin. */
export const HTML_RENDER_HEADLESS_FONT_PATH = "/t3-app-font";

/** An http(s) URL with no characters that could break out of a quoted `url()`. */
const FONT_URL_PATTERN = /^https?:\/\/[A-Za-z0-9_.~:/?#@!$&'*+,;=%-]+$/;
const UNICODE_RANGE_PATTERN =
  /^U\+[0-9A-Fa-f?]+(-[0-9A-Fa-f?]+)?(,U\+[0-9A-Fa-f?]+(-[0-9A-Fa-f?]+)?)*$/;

/**
 * The `@font-face` rules declaring `faces`, dropping entries with an
 * unexpected URL or range. The bootstrap runs the same check on themes that
 * arrive later over postMessage.
 */
export function htmlRenderFontFaceCss(faces: ReadonlyArray<HtmlRenderFontFace>): string {
  return faces
    .flatMap((face) =>
      FONT_URL_PATTERN.test(face.url) && UNICODE_RANGE_PATTERN.test(face.unicodeRange)
        ? [
            `@font-face{font-family:"${HTML_RENDER_APP_FONT_FAMILY}";font-style:normal;font-weight:100 900;font-display:swap;` +
              `src:url("${face.url}") format("woff2-variations");unicode-range:${face.unicodeRange}}`,
          ]
        : [],
    )
    .join("");
}

/** The resolved theme a client hands an HTML render. */
export interface HtmlRenderTheme {
  readonly appearance: ThemeAppearance;
  readonly variables: Readonly<Record<string, string>>;
  /**
   * The app font faces the frame loads. Absent where no host serves them (a
   * downloaded page, a theme read back from storage), where `--font-sans`
   * falls back to the system stack.
   */
  readonly fontFaces?: ReadonlyArray<HtmlRenderFontFace>;
}

// Roles themes cannot change (index.css keeps info/success fixed), plus a
// categorical chart series after the theme's own accent.
const FIXED_COLORS = {
  light: {
    success: "#10b981",
    successForeground: "#047857",
    info: "#3b82f6",
    infoForeground: "#1d4ed8",
    chart: ["#0d9488", "#d97706", "#9333ea", "#e11d48", "#65a30d"],
  },
  dark: {
    success: "#10b981",
    successForeground: "#34d399",
    info: "#3b82f6",
    infoForeground: "#60a5fa",
    chart: ["#2dd4bf", "#fbbf24", "#c084fc", "#fb7185", "#a3e635"],
  },
} as const;

// The in-page surface treatment index.css gives dark mode (search
// "surface-edge" there): one faint hairline, a lit top-left corner and a soft
// halo. Light mode has none and cards fall back to --border. The web client
// reads these live from its stylesheet; these stand in for the headless preview.
const SURFACE_TOKENS = {
  light: {},
  dark: {
    "--surface-edge": "rgb(255 255 255 / 2.2%)",
    "--corner-glow": "7%",
    "--corner-glow-top": "2.8%",
    "--surface-halo": "0 1px 2px rgb(0 0 0 / 30%)",
  },
} as const;

/**
 * Maps a theme palette to the variables HTML renders style against. Names
 * follow the app's own tokens, except `--accent`, which is the theme's brand
 * color here rather than the app's neutral hover surface.
 */
export function htmlRenderTheme(
  colors: ThemeColors,
  appearance: ThemeAppearance,
  fonts: HtmlRenderFonts = HTML_RENDER_DEFAULT_FONTS,
  fontFaces?: ReadonlyArray<HtmlRenderFontFace>,
): HtmlRenderTheme {
  const fixed = FIXED_COLORS[appearance];
  // The frame sets the app family once its faces arrive; pass a stack without
  // it and it is prepended here.
  const sans =
    fontFaces !== undefined &&
    fontFaces.length > 0 &&
    !fonts.sans.includes(HTML_RENDER_APP_FONT_FAMILY)
      ? `"${HTML_RENDER_APP_FONT_FAMILY}", ${fonts.sans}`
      : fonts.sans;
  return {
    appearance,
    ...(fontFaces !== undefined ? { fontFaces } : {}),
    variables: {
      "--background": colors.canvas,
      "--foreground": colors.text,
      "--muted": colors.muted,
      "--muted-foreground": colors.mutedForeground,
      "--card": colors.surface,
      "--card-foreground": colors.text,
      "--popover": colors.surfaceOverlay,
      "--popover-foreground": colors.text,
      "--secondary": colors.secondary,
      "--secondary-foreground": colors.secondaryForeground,
      "--border": colors.border,
      "--input": colors.input,
      "--ring": colors.focus,
      "--primary": colors.messageAction,
      "--primary-foreground": colors.messageActionForeground,
      "--accent": colors.accent,
      "--accent-foreground": colors.accentForeground,
      "--accent-surface": colors.accentSurface,
      "--accent-surface-foreground": colors.accentSurfaceForeground,
      "--destructive": colors.error,
      "--destructive-foreground": colors.errorForeground,
      "--destructive-surface": colors.errorSurface,
      "--warning": colors.warning,
      "--warning-foreground": colors.warningForeground,
      "--warning-surface": colors.warningSurface,
      "--success": fixed.success,
      "--success-foreground": fixed.successForeground,
      "--info": fixed.info,
      "--info-foreground": fixed.infoForeground,
      "--code-background": colors.codeBackground,
      "--code-foreground": colors.codeForeground,
      "--chart-1": colors.accent,
      ...Object.fromEntries(fixed.chart.map((color, index) => [`--chart-${index + 2}`, color])),
      ...SURFACE_TOKENS[appearance],
      // The app's own corner radius (index.css --radius), so kit surfaces match it.
      "--radius": "0.5rem",
      "--font-sans": sans,
      "--font-mono": fonts.mono,
    },
  };
}

/** Agent-facing reference for the injected variables, used in tool descriptions. */
export const HTML_RENDER_THEME_GUIDE = [
  "Cogenly injects its active theme as CSS custom properties on :root, and they follow the user's theme and light/dark mode live:",
  "--background (page background, identical to the thread around the frame), --foreground, --muted, --muted-foreground,",
  "--card, --card-foreground, --popover, --popover-foreground, --secondary, --secondary-foreground, --border, --input, --ring,",
  "--primary, --primary-foreground (solid buttons), --accent, --accent-foreground (brand accent), --accent-surface, --accent-surface-foreground,",
  "--destructive, --destructive-foreground, --destructive-surface, --warning, --warning-foreground, --warning-surface,",
  "--success, --success-foreground, --info, --info-foreground, --code-background, --code-foreground,",
  "--chart-1 … --chart-6 (categorical series for charts), --radius, --font-sans, --font-mono.",
  "The base stylesheet sets html background/color/font from these, body margin to 0, and hides the page's scrollbar; your own CSS overrides it.",
  "The app's Inter travels with the theme from the parent origin, so --font-sans already sets it: never load your own copy.",
  "Take every color from these variables (color-mix() them for tints) rather than hardcoding hex values, and never set your own page background: a hardcoded dark page shows as a box in light mode and against other themes.",
].join(" ");

/** Agent-facing layout rules for a page that sits inside a reply. */
export const HTML_RENDER_LAYOUT_GUIDE = [
  `The frame is borderless on the thread's background, as wide as the reply column (${HTML_RENDER_COLUMN_WIDTH}px on desktop by default, wider if the reader widens chat, about 360px on phones), and its left edge lines up with your reply text.`,
  "The page sits on the thread's own background, so by default leave html, body, and the outermost element with no background color. This overrides general style preferences such as a fixed black page background.",
  "Use a fluid width with no horizontal padding on the outermost element, and no outer card, border, or banner title: the page is part of your reply.",
  "If a box needs its own background (a mock of a specific screen, a panel that must stand apart), give it at least 16px of padding on every side and var(--radius) corners, so content never touches its edge.",
  "Give charts fixed pixel heights rather than heights that scale with width.",
  "Let content set the page's height. Avoid viewport-based heights such as 100vh or height:100% on html or body; the frame grows to fit the page, so they can make it grow again and again.",
].join(" ");

// The bridge between a render and its client speaks the MCP Apps protocol
// (JSON-RPC over postMessage), so the same host code can later drive upstream
// MCP apps: https://github.com/modelcontextprotocol/ext-apps
const HOST_CONTEXT_CHANGED_METHOD = "ui/notifications/host-context-changed";
const OPEN_LINK_METHOD = "ui/open-link";
const SIZE_CHANGED_METHOD = "ui/notifications/size-changed";
// Not part of MCP Apps: a focused frame keeps its keys from the app, so the
// client tells the page which chords are app shortcuts and the page passes
// those on.
const SHORTCUTS_METHOD = "t3/notifications/shortcuts";
const KEY_DOWN_METHOD = "t3/notifications/keydown";
// Not part of MCP Apps: a click on a page image opens it in the app's image viewer.
const OPEN_IMAGE_METHOD = "t3/notifications/open-image";

/** The content height in a framed render's `ui/notifications/size-changed` notification. */
export function readHtmlRenderContentHeight(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== SIZE_CHANGED_METHOD) return undefined;
  const height =
    typeof params === "object" && params !== null
      ? (params as { height?: unknown }).height
      : undefined;
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : undefined;
}

/**
 * A render's `ui/open-link` request, if `data` is one with an http(s) URL. The
 * bootstrap adds the click's Cmd/Ctrl state, so a modifier click can leave the
 * app the way it does from a chat link.
 */
export function readHtmlRenderLinkRequest(data: unknown):
  | {
      readonly id: string | number;
      readonly url: string;
      readonly metaKey: boolean;
      readonly ctrlKey: boolean;
    }
  | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, id, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== OPEN_LINK_METHOD) return undefined;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  if (typeof params !== "object" || params === null) return undefined;
  const { url, metaKey, ctrlKey } = params as Record<string, unknown>;
  return typeof url === "string" && /^https?:\/\//i.test(url)
    ? { id, url, metaKey: metaKey === true, ctrlKey: ctrlKey === true }
    : undefined;
}

/**
 * The image a framed render's reader clicked, if `data` is an open-image
 * notification for an http(s) or inline image URL. Server-side publishing
 * inlines local images, so most arrive as `data:image/` URLs.
 */
export function readHtmlRenderImageRequest(
  data: unknown,
): { readonly src: string; readonly name: string } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== OPEN_IMAGE_METHOD) return undefined;
  if (typeof params !== "object" || params === null) return undefined;
  const { src, name } = params as Record<string, unknown>;
  if (typeof src !== "string" || !/^(?:https?:\/\/|data:image\/)/i.test(src)) return undefined;
  const label = typeof name === "string" ? name.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) : "";
  return { src, name: label || "Image" };
}

/** The key a framed render passed on in a `t3/notifications/keydown` notification. */
export function readHtmlRenderKeyDown(data: unknown):
  | {
      readonly key: string;
      readonly code: string;
      readonly metaKey: boolean;
      readonly ctrlKey: boolean;
      readonly shiftKey: boolean;
      readonly altKey: boolean;
      readonly repeat: boolean;
    }
  | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== KEY_DOWN_METHOD) return undefined;
  if (typeof params !== "object" || params === null) return undefined;
  const { key, code, metaKey, ctrlKey, shiftKey, altKey, repeat } = params as Record<
    string,
    unknown
  >;
  if (typeof key !== "string" || typeof code !== "string") return undefined;
  return {
    key,
    code,
    metaKey: metaKey === true,
    ctrlKey: ctrlKey === true,
    shiftKey: shiftKey === true,
    altKey: altKey === true,
    repeat: repeat === true,
  };
}

/** A chord as the page sees it: `mod` already resolved to Meta or Control. */
export interface HtmlRenderShortcut {
  /** Lowercase key name, as in a keybinding: `k`, `[`, `enter`. */
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/**
 * The `t3/notifications/shortcuts` notification a client posts into a render:
 * the chords it may pass on, and chords of other commands that the page keeps
 * even when one also matches an allowed chord.
 */
export function htmlRenderShortcutsMessage(
  shortcuts: ReadonlyArray<HtmlRenderShortcut>,
  blocked: ReadonlyArray<HtmlRenderShortcut>,
) {
  return { jsonrpc: "2.0", method: SHORTCUTS_METHOD, params: { shortcuts, blocked } } as const;
}

/** The result a client sends back for a render's request. */
export function htmlRenderResult(id: string | number, result: unknown = {}) {
  return { jsonrpc: "2.0", id, result } as const;
}

/** A render's request the client could not satisfy. `reason` names the failure for the page. */
export function htmlRenderVisualError(
  id: string | number,
  reason: "version_conflict" | "locked" | "too_large" | "unavailable",
  message: string,
  data?: Record<string, unknown>,
) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32000, message, data: { reason, ...data } },
  } as const;
}

// The bridge between an interactive render and its client. A page never
// learns its render id: the client pairs each request with the frame that
// sent it (`event.source`), so params carry no ids. Requests are JSON-RPC
// with an id; the host answers with a result or a `htmlRenderVisualError`.
// State changes reach every viewer of the thread through the thread
// projection; the host also pushes them into each mounted frame.
const VISUAL_STATE_GET_METHOD = "t3/visual-state.get";
const VISUAL_STATE_SET_METHOD = "t3/visual-state.set";
const VISUAL_SUBMIT_METHOD = "t3/visual.submit";
const VISUAL_STATE_CHANGED_METHOD = "t3/visual-state.changed";

/** What `window.cogenly.state.get()` resolves with, and what changed pushes carry. */
export interface HtmlRenderVisualSnapshot {
  /** The page's document, or null before the first set. */
  readonly state: unknown;
  /** Starts at 0; a set must pass the version it read. */
  readonly version: number;
  /** A locked visual rejects further sets and submits. */
  readonly locked: boolean;
}

function readVisualRequest(
  data: unknown,
  method: string,
): { readonly id: string | number; readonly params: Record<string, unknown> } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, id, method: actual, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || actual !== method) return undefined;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  if (typeof params !== "object" || params === null) return undefined;
  return { id, params: params as Record<string, unknown> };
}

/** A framed render's `t3/visual-state.get` request. */
export function readHtmlRenderVisualStateGet(data: unknown) {
  const request = readVisualRequest(data, VISUAL_STATE_GET_METHOD);
  return request === undefined ? undefined : { id: request.id };
}

/** A framed render's `t3/visual-state.set` request, if its version is a number. */
export function readHtmlRenderVisualStateSet(
  data: unknown,
):
  | { readonly id: string | number; readonly state: unknown; readonly expectedVersion: number }
  | undefined {
  const request = readVisualRequest(data, VISUAL_STATE_SET_METHOD);
  if (request === undefined || typeof request.params["expectedVersion"] !== "number") {
    return undefined;
  }
  return {
    id: request.id,
    state: request.params["state"],
    expectedVersion: Math.max(0, Math.floor(request.params["expectedVersion"])),
  };
}

/** A framed render's `t3/visual.submit` request. */
export function readHtmlRenderVisualSubmit(
  data: unknown,
): { readonly id: string | number; readonly payload: unknown; readonly lock: boolean } | undefined {
  const request = readVisualRequest(data, VISUAL_SUBMIT_METHOD);
  if (request === undefined) return undefined;
  return {
    id: request.id,
    payload: request.params["payload"],
    lock: request.params["lock"] === true,
  };
}

/**
 * The user-turn text a visual submit lands as. The bracketed first line is
 * the timeline's chip marker; clients render a message that opens with it
 * compactly instead of showing the JSON wall. The agent parses the fence.
 */
export function formatVisualSubmitMessage(title: string, payloadJson: string): string {
  const label =
    title.trim() === ""
      ? "Visual"
      : `Visual "${title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH)}"`;
  return `[${label} submitted]\n\`\`\`json\n${payloadJson}\n\`\`\``;
}

const VISUAL_SUBMIT_MESSAGE_PATTERN =
  /^\[Visual(?: "(.*)")? submitted\][ \t]*\r?\n```json[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/;

/**
 * The parts of a `formatVisualSubmitMessage` text: the visual's title (null
 * for an untitled one), the fence's JSON as written, and its parsed payload
 * (undefined when the fence is not valid JSON). Undefined for any other text.
 */
export function readVisualSubmitMessage(
  text: string,
): { readonly title: string | null; readonly json: string; readonly payload: unknown } | undefined {
  const match = VISUAL_SUBMIT_MESSAGE_PATTERN.exec(text);
  if (match === null) return undefined;
  const json = match[2]!.trim();
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    payload = undefined;
  }
  return { title: match[1]?.trim() || null, json, payload };
}

/** UTF-8 bytes of a JSON value's encoding, or null when it cannot be encoded. */
export function visualStateJsonBytes(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? "null").length;
  } catch {
    return null;
  }
}

/** A visual submit payload as indented JSON, or null when it cannot be encoded. */
export function visualPayloadJson(payload: unknown): string | null {
  try {
    return JSON.stringify(payload, null, 2) ?? "null";
  } catch {
    return null;
  }
}

/** The `t3/visual-state.changed` notification a client posts into a mounted render. */
export function htmlRenderVisualStateChangedMessage(snapshot: HtmlRenderVisualSnapshot) {
  return {
    jsonrpc: "2.0",
    method: VISUAL_STATE_CHANGED_METHOD,
    params: { state: snapshot.state ?? null, version: snapshot.version, locked: snapshot.locked },
  } as const;
}

const THEME_FRAGMENT_KEY = "t3-theme";

/** URL fragment that hands a render its theme before first paint. */
export function htmlRenderThemeFragment(theme: HtmlRenderTheme): string {
  return `#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;
}

/** The `host-context-changed` notification a client posts into a mounted render when the theme changes. */
export function htmlRenderThemeMessage(theme: HtmlRenderTheme) {
  return {
    jsonrpc: "2.0",
    method: HOST_CONTEXT_CHANGED_METHOD,
    params: {
      theme: theme.appearance,
      styles: { variables: theme.variables },
      ...(theme.fontFaces !== undefined ? { fontFaces: theme.fontFaces } : {}),
    },
  } as const;
}

// The frame scrolls a page taller than itself, but a scrollbar inside the
// reply reads as a box within the thread, so it stays hidden. A small gutter
// keeps rings, shadows and selected outlines on the page's outermost elements
// inside the frame, which would otherwise clip them at its edges; the server
// measures with the same gutter, so heights still fit.
const BASE_CSS =
  "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none;padding:4px}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}" +
  // Focus outlines paint inside the element, so the frame edge never clips them.
  ":where(:focus-visible){outline:2px solid var(--ring)}:focus-visible{outline-width:2px!important;outline-offset:-2px!important}" +
  // An image outside a link or button opens in the app's viewer, as chat images do.
  ":where(img:not(a[href] img,button img)){cursor:zoom-in}";

function rootRule(theme: HtmlRenderTheme): string {
  const declarations = Object.entries(theme.variables)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  const faces = theme.fontFaces === undefined ? "" : htmlRenderFontFaceCss(theme.fontFaces);
  return `${faces}:root{color-scheme:${theme.appearance};${declarations}}`;
}

// Runs synchronously in <head>, before the page's own styles and body, so the
// first paint is already themed. It rewrites its own <style> element rather
// than setting inline properties, so a page's later `:root` rules still win,
// then drops the fragment so a page's own hash routing never sees it. A link
// the reader clicks to another page never replaces the page inside the thread:
// a framed page asks its client to open it, and a top-level page (mobile)
// opens it as a new window, which the client sends to the browser. A plain
// left click on a framed page's image, outside a link or button and not
// prevented by any of the page's listeners, asks the client to open the image
// in its viewer. A framed page also reports its content height, measured as the server measures it,
// so its client can fit the frame to the page. A chord the client named as an
// app shortcut is passed on rather than left to the browser, unless a text
// field has focus or the page handled it: the deciding listener is added while
// the key dispatches, so it runs after every listener the page has. Keys
// match as resolveEventKeys reads them, so the client accepts what it claims.
const BOOTSTRAP_SCRIPT = `(function(){var s=document.getElementById("t3-theme"),n=0;if(!s)return;var b=${JSON.stringify(BASE_CSS)};var f="";function v(u){return typeof u==="string"&&/^https?:[/][/][A-Za-z0-9_.~:/?#@!$&'*+,;=%-]+$/.test(u);}function r(g){return typeof g==="string"&&/^U[+][0-9A-Fa-f?]+(-[0-9A-Fa-f?]+)?(,U[+][0-9A-Fa-f?]+(-[0-9A-Fa-f?]+)?)*$/.test(g);}function o(q){if(!Array.isArray(q))return null;var e="";for(var i=0;i<q.length;i++){var d=q[i];if(!d||typeof d!=="object"||!v(d.url)||!r(d.unicodeRange))return null;e+='@font-face{font-family:"Inter Variable";font-style:normal;font-weight:100 900;font-display:swap;src:url("'+d.url+'") format("woff2-variations");unicode-range:'+d.unicodeRange+'}';}return e;}function a(t){if(!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>]/g,"")+";";}var q=o(t.fontFaces);if(q!==null)f=q;s.textContent=f+c+"}"+b;}try{var m=/[#&]${THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash);if(m){a(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}}catch(e){}window.addEventListener("message",function(e){var d=e.data,p=d&&d.params;if(d&&d.jsonrpc==="2.0"&&d.method===${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}&&p&&p.styles)a({appearance:p.theme,variables:p.styles.variables,fontFaces:p.fontFaces});});document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol)||u.href.split("#")[0]===location.href.split("#")[0])return;if(window.parent!==window){e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",id:"t3-link-"+(++n),method:${JSON.stringify(OPEN_LINK_METHOD)},params:{url:u.href,metaKey:e.metaKey,ctrlKey:e.ctrlKey}},"*");}else{l.setAttribute("target","_blank");l.setAttribute("rel","noopener");}},true);if(window.parent!==window){var h,o,z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(SIZE_CHANGED_METHOD)},params:{height:v}},"*");};if(window.ResizeObserver){o=new ResizeObserver(z);o.observe(document.documentElement);}document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);window.addEventListener("click",function(e){var t=e.composedPath()[0],u;if(!e.isTrusted||e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||!t||t.tagName!=="IMG"||t.closest("a[href],button"))return;u=t.currentSrc||t.src;if(u)setTimeout(function(){if(!e.defaultPrevented)window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(OPEN_IMAGE_METHOD)},params:{src:u,name:t.alt||t.title||""}},"*");});});var K=[],B=[],C=${JSON.stringify(EVENT_CODE_SHORTCUT_KEYS)};window.addEventListener("message",function(e){var d=e.data,p=d&&d.params;if(e.source===window.parent&&d&&d.jsonrpc==="2.0"&&d.method===${JSON.stringify(SHORTCUTS_METHOD)}&&p&&Array.isArray(p.shortcuts)&&Array.isArray(p.blocked)){K=p.shortcuts;B=p.blocked;}});window.addEventListener("keydown",function(e){var t=e.composedPath()[0],c=e.code||"",l=e.key.toLowerCase(),x=/^[a-z]$/.test(l)?[l]:[l,/^Key[A-Z]$/.test(c)?c.slice(3).toLowerCase():"",C.hasOwnProperty(c)?C[c]:""],f,m=function(s){return s&&s.metaKey===e.metaKey&&s.ctrlKey===e.ctrlKey&&s.shiftKey===e.shiftKey&&s.altKey===e.altKey&&x.indexOf(s.key)>-1;};if(!e.isTrusted||e.isComposing||e.getModifierState("AltGraph")&&!/^[a-z0-9]$/i.test(e.key)||t&&(t.isContentEditable||/^(?:INPUT|TEXTAREA|SELECT)$/.test(t.tagName))||!K.some(m)||B.some(m))return;f=function(v){window.removeEventListener("keydown",f);if(v!==e||e.defaultPrevented)return;e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(KEY_DOWN_METHOD)},params:{key:e.key,code:e.code,metaKey:e.metaKey,ctrlKey:e.ctrlKey,shiftKey:e.shiftKey,altKey:e.altKey,repeat:e.repeat}},"*");};window.addEventListener("keydown",f);setTimeout(function(){window.removeEventListener("keydown",f);});},true);}})();`;

// The page side of the interactive bridge. It exposes `window.cogenly` with
// the state document the thread stores for this render: `state.get()` reads
// it, `state.set(json)` writes it with the version the page last saw (pass an
// explicit version after merging a conflict), `state.subscribe(cb)` hears
// every change, and `submit(payload, { lock })` delivers a result to the
// agent as a new user turn. Requests that no client answers (an old app
// showing the page) reject after ten seconds rather than hanging.
const VISUAL_BRIDGE_SCRIPT = `(function(){if(window.cogenly&&window.cogenly.state)return;var n=0,p={},subs=[],latest={state:null,version:0,locked:false};function call(m,params){return new Promise(function(ok,no){if(window.parent===window){no(new Error("Interactive visuals need the Cogenly client."));return;}var id="cogenly-"+(++n);var t=setTimeout(function(){if(!p[id])return;delete p[id];no(new Error("The Cogenly client did not answer "+m+"; update the app to use interactive visuals."));},10000);p[id]={ok:ok,no:no,t:t};window.parent.postMessage({jsonrpc:"2.0",id:id,method:m,params:params},"*");});}window.addEventListener("message",function(e){if(e.source!==window.parent)return;var d=e.data;if(!d||d.jsonrpc!=="2.0")return;if(d.id!==undefined&&p[d.id]){var q=p[d.id];delete p[d.id];clearTimeout(q.t);if(d.error)q.no(new Error((d.error&&d.error.message)||"The visual request failed."));else q.ok(d.result||{});return;}if(d.method===${JSON.stringify(VISUAL_STATE_CHANGED_METHOD)}&&d.params){var s={state:d.params.state===undefined?null:d.params.state,version:d.params.version|0,locked:d.params.locked===true};latest=s;subs.slice().forEach(function(cb){try{cb(s);}catch(x){}});}});window.cogenly={state:{get:function(){return call(${JSON.stringify(VISUAL_STATE_GET_METHOD)},{ }).then(function(r){var s={state:r.state===undefined?null:r.state,version:r.version|0,locked:r.locked===true};latest=s;return s;});},set:function(state,expectedVersion){var v=expectedVersion===undefined?latest.version:expectedVersion;return call(${JSON.stringify(VISUAL_STATE_SET_METHOD)},{state:state,expectedVersion:v}).then(function(r){var s={state:state,version:r.version===undefined?v+1:r.version,locked:latest.locked};latest=s;return s.version;});},subscribe:function(cb){subs.push(cb);return function(){var i=subs.indexOf(cb);if(i>-1)subs.splice(i,1);};}},submit:function(payload,options){return call(${JSON.stringify(VISUAL_SUBMIT_METHOD)},{payload:payload,lock:!!(options&&options.lock)}).then(function(){return undefined;});}};})();`;

/** Agent-facing reference for building an interactive page against `window.cogenly`. */
export const HTML_RENDER_STATE_GUIDE = [
  "An interactive page keeps a small JSON document (at most 64KB) with the thread, readable when the page re-mounts and synced to every client. The page never learns its render id: `window.cogenly` pairs each call with its frame, and the server pairs the frame with the render.",
  "`await window.cogenly.state.get()` returns `{ state, version, locked }`. `await window.cogenly.state.set(json)` writes the document with the version the page last saw and resolves with the new version; a write that lost a race rejects, so read again, merge, and retry. `window.cogenly.state.subscribe(cb)` hears every change and returns an unsubscribe function.",
  "`await window.cogenly.submit(payload, { lock: true })` delivers a result to the agent as a new user turn in the same thread, even while a turn is running (it queues behind it). Pass `lock: true` for a quiz that cannot be taken twice; further writes and submits then fail.",
  'Quiz example: `const { state } = await window.cogenly.state.get();` render from `state`; on each answer `await window.cogenly.state.set({ answers })`; on Finish `await window.cogenly.submit({ kind: "quiz-result", score, answers }, { lock: true })` and show a submitted note.',
].join(" ");

export const HTML_RENDER_KIT_STYLE_ID = "t3-kit";

function bootstrapMarkup(markup: string, kit: boolean): string {
  const dark = htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark");
  const light = htmlRenderTheme(T3_CODE_LIGHT_THEME_COLORS, "light");
  // Without a client-provided theme (a direct download, the headless preview
  // without a fragment) the page follows the OS appearance.
  const defaultCss = `${rootRule(dark)}@media (prefers-color-scheme: light){${rootRule(light)}}${BASE_CSS}`;
  return [
    /<meta\s[^>]*charset/i.test(markup.slice(0, 4096)) ? "" : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(markup)
      ? ""
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="t3-theme">${defaultCss}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
    `<script>${VISUAL_BRIDGE_SCRIPT}</script>`,
    // The kit follows the bridge (its components write window.cogenly.state)
    // and precedes the page's own head, so the page's styles override it.
    ...(kit
      ? [
          `<style id="${HTML_RENDER_KIT_STYLE_ID}">${HTML_RENDER_KIT_CSS}</style>`,
          `<script>${HTML_RENDER_KIT_SCRIPT}</script>`,
        ]
      : []),
  ].join("");
}

/** A page declines the kit with `<html data-cg="off">`. */
export function htmlRenderKitOptedOut(html: string): boolean {
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(blankNonMarkup(html));
  return htmlOpen !== null && /\sdata-cg\s*=\s*["']?off(?:["'\s/>]|$)/i.test(htmlOpen[0]);
}

// Comments, raw text, and template contents are blanked to the same length,
// so offsets still line up and inert tags cannot receive the bootstrap.
const blankNonMarkup = (html: string) => {
  const scan = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => " ".repeat(match.length),
  );
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let at = 0;
  for (const match of scan.matchAll(/<(\/?)template(?:\s[^>]*)?\/?>/gi)) {
    if (!match[1]) {
      if (depth++ === 0) start = match.index;
    } else if (depth > 0 && --depth === 0) {
      const end = match.index + match[0].length;
      parts.push(scan.slice(at, start), " ".repeat(end - start));
      at = end;
    }
  }
  if (depth > 0) {
    parts.push(scan.slice(at, start), " ".repeat(scan.length - start));
    at = scan.length;
  }
  parts.push(scan.slice(at));
  return parts.join("");
};

/**
 * Inserts the theme bootstrap, and by default the Cogenly kit, at the start
 * of the document head, so a page's own styles and scripts come after them.
 * `kit: false` or `<html data-cg="off">` leaves the page with the theme alone.
 */
export function injectHtmlRenderBootstrap(
  html: string,
  options: { readonly kit?: boolean | undefined } = {},
): string {
  const scan = blankNonMarkup(html);
  const kit = options.kit !== false && !htmlRenderKitOptedOut(scan);
  const markup = bootstrapMarkup(scan, kit);
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}

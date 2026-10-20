// @effect-diagnostics nodeBuiltinImport:off - reads the stylesheet and theme sources under test.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";

import {
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
  THEME_COLOR_ROLES,
  type ThemeColors,
} from "@t3tools/shared/themePalettes";

// Source text, not bundled output: the test pins the palettes to what the
// stylesheet says.
const indexCss = NodeFS.readFileSync(new URL("./index.css", import.meta.url), "utf8");
const tailwindThemeCss = NodeFS.readFileSync(
  NodeModule.createRequire(import.meta.url).resolve("tailwindcss/theme.css"),
  "utf8",
);

/**
 * The headless palettes are snapshots of the app's stock tokens: `:root`
 * plus its nested `@variant dark` in index.css, with translucent tokens
 * flattened over their backdrops. This test re-resolves them from the CSS
 * source, so any token change that the palettes do not follow fails CI.
 *
 * Roles with no stock source stay out of the mapping and are listed in
 * `UNMAPPED_ROLES`; adding a stock token for one means mapping it here.
 */

type Rgb = { readonly r: number; readonly g: number; readonly b: number; readonly a: number };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function hexRgb(hex: string): Rgb {
  let digits = hex.slice(1);
  if (digits.length === 3 || digits.length === 4) digits = [...digits].map((c) => c + c).join("");
  const packed = parseInt(digits.slice(0, 6), 16);
  return {
    r: ((packed >> 16) & 255) / 255,
    g: ((packed >> 8) & 255) / 255,
    b: (packed & 255) / 255,
    a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
  };
}

function parseAlpha(text: string): number {
  const trimmed = text.trim();
  return trimmed.endsWith("%") ? clamp01(parseFloat(trimmed) / 100) : clamp01(parseFloat(trimmed));
}

function parseRgbArgs(inner: string): Rgb {
  const [columns, alpha] = inner.split("/").map((part) => part.trim());
  const parts = columns!.split(/[\s,]+/).filter(Boolean);
  const channel = (value: string) =>
    value.endsWith("%") ? clamp01(parseFloat(value) / 100) : clamp01(parseFloat(value) / 255);
  return {
    r: channel(parts[0]!),
    g: channel(parts[1]!),
    b: channel(parts[2]!),
    a: alpha === undefined ? 1 : parseAlpha(alpha),
  };
}

const srgbToLinear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
const linearToSrgb = (channel: number) =>
  channel <= 0.0031308 ? 12.92 * channel : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;

function srgbToOklab(color: Rgb): { readonly L: number; readonly a: number; readonly b: number } {
  const lr = srgbToLinear(color.r);
  const lg = srgbToLinear(color.g);
  const lb = srgbToLinear(color.b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);
  return {
    L: 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
    a: 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
    b: 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot,
  };
}

function oklabToSrgb(lab: { readonly L: number; readonly a: number; readonly b: number }): Rgb {
  const lRoot = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const mRoot = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const sRoot = lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  return {
    r: clamp01(linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: clamp01(linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: clamp01(linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
    a: 1,
  };
}

function parseOklch(inner: string): Rgb {
  const [lch, alpha] = inner.split("/").map((part) => part.trim());
  const parts = lch!.split(/\s+/).filter(Boolean);
  const number = (value: string) => (value === "none" ? 0 : parseFloat(value));
  const lightness = parts[0]!.endsWith("%") ? number(parts[0]!) / 100 : number(parts[0]!);
  const chroma = number(parts[1]!);
  const hue = (number(parts[2]!) * Math.PI) / 180;
  return {
    ...oklabToSrgb({ L: lightness, a: chroma * Math.cos(hue), b: chroma * Math.sin(hue) }),
    a: alpha === undefined ? 1 : parseAlpha(alpha),
  };
}

function mixIn(first: Rgb, fraction: number, second: Rgb, space: "srgb" | "oklab"): Rgb {
  const toSpace =
    space === "srgb"
      ? (color: Rgb) => ({ L: color.r, a: color.g, b: color.b })
      : (color: Rgb) => srgbToOklab(color);
  const fromSpace =
    space === "srgb"
      ? (lab: { readonly L: number; readonly a: number; readonly b: number }) => ({
          r: lab.L,
          g: lab.a,
          b: lab.b,
        })
      : (lab: { readonly L: number; readonly a: number; readonly b: number }) => oklabToSrgb(lab);
  const left = toSpace(first);
  const right = toSpace(second);
  const alpha = fraction * first.a + (1 - fraction) * second.a;
  const channel = (x: number, y: number) =>
    (fraction * first.a * x + (1 - fraction) * second.a * y) / (alpha === 0 ? 1 : alpha);
  return {
    ...fromSpace({
      L: channel(left.L, right.L),
      a: channel(left.a, right.a),
      b: channel(left.b, right.b),
    }),
    a: alpha,
  };
}

/** Splits on top-level commas, so nested function calls stay whole. */
function splitTopLevel(text: string): Array<string> {
  const parts: Array<string> = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function resolveColor(
  value: string,
  table: Readonly<Record<string, string>>,
  seen: ReadonlyArray<string> = [],
): Rgb {
  const trimmed = value.trim();
  if (seen.length > 12) throw new Error(`Color cycle: ${seen.join(" > ")}`);
  let match: RegExpExecArray | null;
  if ((match = /^var\(\s*(--[a-zA-Z0-9-]+)\s*\)$/.exec(trimmed)) !== null) {
    const found = table[match[1]!];
    if (found === undefined) throw new Error(`Unknown token ${match[1]}`);
    return resolveColor(found, table, [...seen, match[1]!]);
  }
  if ((match = /^--alpha\(\s*(.+)\s*\/\s*([^/]+)\)$/.exec(trimmed)) !== null) {
    const color = resolveColor(match[1]!, table, seen);
    return { ...color, a: color.a * parseAlpha(match[2]!) };
  }
  if ((match = /^color-mix\(\s*in\s+(srgb|oklab)\s*,(.+)\)$/s.exec(trimmed)) !== null) {
    const [left, right] = splitTopLevel(match[2]!);
    const weighted = /^\s*(.+?)\s+([0-9.]+%)\s*$/.exec(left!);
    if (weighted === null || right === undefined) throw new Error(`Bad mix: ${trimmed}`);
    return mixIn(
      resolveColor(weighted[1]!, table, seen),
      parseFloat(weighted[2]!) / 100,
      resolveColor(right.trim(), table, seen),
      match[1] as "srgb" | "oklab",
    );
  }
  if ((match = /^color-mix\(\s*(.+)\)$/s.exec(trimmed)) !== null) {
    const [left, right] = splitTopLevel(match[1]!);
    const weighted = /^\s*(.+?)\s+([0-9.]+%)\s*$/.exec(left!);
    if (weighted === null || right === undefined) throw new Error(`Bad mix: ${trimmed}`);
    return mixIn(
      resolveColor(weighted[1]!, table, seen),
      parseFloat(weighted[2]!) / 100,
      resolveColor(right.trim(), table, seen),
      "oklab",
    );
  }
  if ((match = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(trimmed)) !== null) {
    return hexRgb(trimmed);
  }
  if ((match = /^rgba?\((.+)\)$/s.exec(trimmed)) !== null) return parseRgbArgs(match[1]!);
  if ((match = /^oklch\((.+)\)$/s.exec(trimmed)) !== null) return parseOklch(match[1]!);
  if (trimmed === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (trimmed === "white") return { r: 1, g: 1, b: 1, a: 1 };
  if (trimmed === "black") return { r: 0, g: 0, b: 0, a: 1 };
  throw new Error(`Cannot resolve: ${trimmed}`);
}

const toHex = (color: Rgb): string => {
  const channel = (value: number) =>
    Math.round(clamp01(value) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
};

const flattenOver = (foreground: Rgb, background: Rgb): Rgb => ({
  r: foreground.r * foreground.a + background.r * (1 - foreground.a),
  g: foreground.g * foreground.a + background.g * (1 - foreground.a),
  b: foreground.b * foreground.a + background.b * (1 - foreground.a),
  a: 1,
});

/**
 * Every depth-0 `:root` block's own declarations, merged in source order, plus
 * the `@variant dark` blocks nested directly in them. Sidebar and theme-file
 * overrides live under other selectors and stay out.
 */
function extractStockTokens(): {
  readonly light: Record<string, string>;
  readonly dark: Record<string, string>;
} {
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  const stack: Array<{
    readonly selector: string;
    readonly start: number;
    readonly depth: number;
  }> = [];
  let depth = 0;
  let at = 0;
  const takeDeclarations = (body: string, into: Record<string, string>) => {
    let stripped = "";
    let nested = 0;
    for (const char of body) {
      if (char === "{") nested += 1;
      else if (char === "}") nested -= 1;
      else if (nested === 0) stripped += char;
    }
    for (const match of stripped.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
      into[match[1]!] = match[2]!.trim();
    }
  };
  while (at < indexCss.length) {
    const char = indexCss[at];
    if (char === "{") {
      let back = at - 1;
      while (back >= 0 && indexCss[back] !== "}" && indexCss[back] !== ";") back -= 1;
      const selector = indexCss
        .slice(back + 1, at)
        .trim()
        .split("\n")
        .pop()!
        .trim();
      stack.push({ selector, start: at + 1, depth });
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      const frame = stack.pop();
      if (frame !== undefined) {
        const body = indexCss.slice(frame.start, at);
        if (frame.depth === 0 && frame.selector === ":root") {
          takeDeclarations(body, light);
        }
        if (
          frame.depth === 1 &&
          frame.selector === "@variant dark" &&
          stack.length > 0 &&
          stack[stack.length - 1]!.selector === ":root" &&
          stack[stack.length - 1]!.depth === 0
        ) {
          takeDeclarations(body, dark);
        }
      }
    }
    at += 1;
  }
  return { light, dark };
}

/** `tailwindcss/theme.css` plus the app's own `--color-*` additions. */
function tailwindColors(): Record<string, string> {
  const table: Record<string, string> = {};
  for (const match of tailwindThemeCss.matchAll(/(--color-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    table[match[1]!] = match[2]!.trim();
  }
  for (const match of indexCss.matchAll(/(--color-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    table[match[1]!] = match[2]!.trim();
  }
  return table;
}

type Backdrop = "canvas" | "sidebar" | "terminalBackground";

/**
 * Each palette role, the stock token behind it, and what a translucent token
 * flattens over (the canvas unless named). Mirrors how `htmlRenderTheme`
 * reads the palette.
 */
const ROLE_SOURCES: ReadonlyArray<readonly [role: string, token: string, backdrop?: Backdrop]> = [
  ["canvas", "--background"],
  ["chrome", "--app-chrome-background"],
  ["toolbar", "--toolbar-background"],
  ["toolbarForeground", "--toolbar-foreground"],
  ["toolbarBorder", "--toolbar-border"],
  ["toolbarControl", "--toolbar-control"],
  ["toolbarControlForeground", "--toolbar-control-foreground"],
  ["toolbarControlHover", "--toolbar-control-hover"],
  ["surface", "--card"],
  ["surfaceRaised", "--surface-raised"],
  ["surfaceOverlay", "--popover"],
  ["text", "--foreground"],
  ["textMuted", "--muted-foreground"],
  ["border", "--border"],
  ["input", "--input"],
  ["focus", "--ring"],
  ["accent", "--accent"],
  ["accentForeground", "--accent-foreground"],
  ["secondary", "--secondary"],
  ["secondaryForeground", "--secondary-foreground"],
  ["muted", "--muted"],
  ["mutedForeground", "--muted-foreground"],
  ["placeholder", "--placeholder"],
  ["secondaryLabel", "--secondary-label"],
  ["iconMuted", "--icon-muted"],
  ["error", "--error"],
  ["errorForeground", "--error-foreground"],
  ["errorSurface", "--error-surface"],
  ["warning", "--warning"],
  ["warningForeground", "--warning-foreground"],
  ["warningSurface", "--warning-surface"],
  ["update", "--update"],
  ["updateForeground", "--update-foreground"],
  ["updateSurface", "--update-surface"],
  ["messageSurface", "--message-surface"],
  ["messageForeground", "--message-foreground"],
  ["messageAction", "--message-action"],
  ["messageActionForeground", "--message-action-foreground"],
  ["messageActionHover", "--message-action-hover"],
  ["codeBackground", "--code-background"],
  ["codeForeground", "--code-foreground"],
  ["sidebar", "--sidebar"],
  ["sidebarForeground", "--sidebar-foreground"],
  ["sidebarMutedForeground", "--sidebar-muted-foreground"],
  ["sidebarControlSurface", "--sidebar-control-surface", "sidebar"],
  ["sidebarRowHover", "--sidebar-row-hover", "sidebar"],
  ["sidebarRowActive", "--sidebar-row-active", "sidebar"],
  ["sidebarRowSelected", "--sidebar-row-selected", "sidebar"],
  ["sidebarBorder", "--sidebar-border"],
  ["terminalBackground", "--terminal-background"],
  ["terminalForeground", "--terminal-foreground"],
  ["terminalCursor", "--terminal-cursor"],
  ["terminalSelection", "--terminal-selection-background", "terminalBackground"],
  ["terminalScrollbar", "--app-scrollbar-thumb"],
  ["terminalScrollbarHover", "--app-scrollbar-thumb-hover"],
];

/** Palette roles with no stock token behind them; update this list deliberately. */
const UNMAPPED_ROLES: ReadonlyArray<string> = ["accentSurface", "accentSurfaceForeground"];

/** The `::highlight` fallback a find tint resolves from per appearance. */
function highlightFallback(
  rule: "t3-thread-find" | "t3-thread-find-active",
  property: string,
  appearance: "light" | "dark",
): string {
  const outer = new RegExp(`::highlight\\(${rule}\\)\\s*\\{([^}]*)\\}`).exec(indexCss)?.[1] ?? "";
  // The outer match ends at the dark variant's own closing brace, so the dark
  // section runs to the end of the captured text.
  const block =
    appearance === "dark" ? (/@variant dark\s*\{([\s\S]*)$/.exec(outer)?.[1] ?? outer) : outer;
  const found = new RegExp(`${property}:\\s*var\\([^,]+,\\s*([a-z]+\\([^)]*\\))`).exec(block)?.[1];
  if (found === undefined) throw new Error(`No ${property} fallback for ${rule} (${appearance})`);
  return found;
}

function expectedPalette(
  appearance: "light" | "dark",
  table: Readonly<Record<string, string>>,
): Record<string, string> {
  const expected: Record<string, string> = {};
  const flattened: Record<string, Rgb> = {};
  const resolve = (role: string, token: string, backdrop?: Backdrop): Rgb => {
    const color = resolveColor(`var(${token})`, table);
    if (color.a >= 1) {
      flattened[role] = color;
      return color;
    }
    const backdropRole = backdrop ?? "canvas";
    const backdropToken =
      backdropRole === "sidebar"
        ? "--sidebar"
        : backdropRole === "terminalBackground"
          ? "--terminal-background"
          : "--background";
    const background = flattened[backdropRole] ?? resolveColor(`var(${backdropToken})`, table);
    const flat = flattenOver(color, background);
    flattened[role] = flat;
    return flat;
  };
  for (const [role, token, backdrop] of ROLE_SOURCES) {
    expected[role] = toHex(resolve(role, token, backdrop));
  }
  expected["searchMatchBackground"] = toHex(
    resolveColor(highlightFallback("t3-thread-find", "background-color", appearance), table),
  );
  expected["searchMatchForeground"] = toHex(
    resolveColor(highlightFallback("t3-thread-find", "color", appearance), table),
  );
  expected["searchMatchActiveBackground"] = toHex(
    resolveColor(highlightFallback("t3-thread-find-active", "background-color", appearance), table),
  );
  expected["searchMatchActiveForeground"] = toHex(
    resolveColor(highlightFallback("t3-thread-find-active", "color", appearance), table),
  );
  return expected;
}

describe("theme palette sync", () => {
  it("covers every theme role or names it unmapped", () => {
    const mapped = new Set([
      ...ROLE_SOURCES.map(([role]) => role),
      "searchMatchBackground",
      "searchMatchForeground",
      "searchMatchActiveBackground",
      "searchMatchActiveForeground",
      ...UNMAPPED_ROLES,
    ]);
    for (const role of THEME_COLOR_ROLES) {
      expect(mapped.has(role), `${role} needs a stock token or a reason in UNMAPPED_ROLES`).toBe(
        true,
      );
    }
    expect(mapped.size).toBe(THEME_COLOR_ROLES.length);
  });

  it.each(["light", "dark"] as const)("matches the stock %s tokens", (appearance) => {
    const { light, dark } = extractStockTokens();
    const table = { ...tailwindColors(), ...light };
    if (appearance === "dark") Object.assign(table, dark);
    const palette: ThemeColors =
      appearance === "light" ? T3_CODE_LIGHT_THEME_COLORS : T3_CODE_DARK_THEME_COLORS;
    const expected = expectedPalette(appearance, table);
    const mismatches = Object.entries(expected).flatMap(([role, hex]) =>
      (palette[role as keyof ThemeColors] as string).toLowerCase() === hex
        ? []
        : [{ role, css: hex, palette: palette[role as keyof ThemeColors] }],
    );
    expect(mismatches).toEqual([]);
  });
});

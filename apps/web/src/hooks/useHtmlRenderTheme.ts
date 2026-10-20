import {
  htmlRenderTheme,
  HTML_RENDER_APP_FONT_FILES,
  HTML_RENDER_DEFAULT_FONTS,
  type HtmlRenderFontFace,
  type HtmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import interLatinExtUrl from "@t3tools/shared/fonts/inter-latin-ext-wght-normal.woff2?url";
import interLatinUrl from "@t3tools/shared/fonts/inter-latin-wght-normal.woff2?url";
import {
  T3_CODE_LIGHT_THEME_COLORS,
  T3_CODE_DARK_THEME_COLORS,
} from "@t3tools/shared/themePalettes";
import { useEffect, useMemo, useState } from "react";
import { useTheme } from "./useTheme";

const FONT_FILE_URLS: Record<string, string> = {
  "inter-latin-wght-normal.woff2": interLatinUrl,
  "inter-latin-ext-wght-normal.woff2": interLatinExtUrl,
};

/**
 * The app's Inter as this page serves it: absolute URLs on this origin, so a
 * sandboxed frame (opaque origin, CORS fetch) sets the same type the app
 * wears. Hashed asset URLs never change within a page load.
 */
function appFontFaces(): ReadonlyArray<HtmlRenderFontFace> {
  if (typeof window === "undefined") return [];
  const origin = window.location.origin;
  return HTML_RENDER_APP_FONT_FILES.flatMap((file) => {
    const path = FONT_FILE_URLS[file.file];
    return path === undefined ? [] : [{ url: `${origin}${path}`, unicodeRange: file.unicodeRange }];
  });
}

const APP_FONT_FACES = appFontFaces();

/**
 * Tokens a page reads with the same meaning the app gives them. They come from
 * the live stylesheet rather than the stock palette, which can drift from
 * index.css, so a page's background is exactly the thread's around the frame.
 */
const LIVE_TOKENS = [
  "--background",
  "--foreground",
  "--muted",
  "--muted-foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--border",
  "--input",
  "--ring",
  "--radius",
  // The kit's card treatment (index.css "surface-edge"); unset in light mode.
  "--surface-edge",
  "--corner-glow",
  "--corner-glow-top",
  "--surface-halo",
] as const;

function readLiveTokens(): Readonly<Record<string, string>> {
  if (typeof document === "undefined") return {};
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of LIVE_TOKENS) {
    const value = style.getPropertyValue(name).trim();
    if (value !== "") tokens[name] = value;
  }
  return tokens;
}

export function useHtmlRenderTheme(): HtmlRenderTheme {
  const { resolvedTheme } = useTheme();
  const [live, setLive] = useState(() => ({
    appearance: resolvedTheme,
    tokens: readLiveTokens(),
  }));
  // Runs after useTheme's own effect has switched the root's dark class, so
  // the stylesheet already resolves to the new appearance.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Reads the stylesheet the theme switch just applied.
    setLive({ appearance: resolvedTheme, tokens: readLiveTokens() });
  }, [resolvedTheme]);
  return useMemo(() => {
    const theme = htmlRenderTheme(
      resolvedTheme === "dark" ? T3_CODE_DARK_THEME_COLORS : T3_CODE_LIGHT_THEME_COLORS,
      resolvedTheme,
      HTML_RENDER_DEFAULT_FONTS,
      APP_FONT_FACES,
    );
    // Until the stylesheet catches up with a switch, the stock palette stands in.
    if (live.appearance !== resolvedTheme) return theme;
    return { ...theme, variables: { ...theme.variables, ...live.tokens } };
  }, [resolvedTheme, live]);
}

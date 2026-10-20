import {
  htmlRenderTheme,
  HTML_RENDER_DEFAULT_FONTS,
  type HtmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import {
  T3_CODE_LIGHT_THEME_COLORS,
  T3_CODE_DARK_THEME_COLORS,
} from "@t3tools/shared/themePalettes";
import { useEffect, useMemo, useState } from "react";
import { useTheme } from "./useTheme";

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
    );
    // Until the stylesheet catches up with a switch, the stock palette stands in.
    if (live.appearance !== resolvedTheme) return theme;
    return { ...theme, variables: { ...theme.variables, ...live.tokens } };
  }, [resolvedTheme, live]);
}

import { htmlRenderTheme, HTML_RENDER_DEFAULT_FONTS } from "@t3tools/shared/htmlRender";
import {
  T3_CODE_LIGHT_THEME_COLORS,
  T3_CODE_DARK_THEME_COLORS,
} from "@t3tools/shared/themePalettes";
import { useMemo } from "react";
import { useTheme } from "./useTheme";
export function useHtmlRenderTheme() {
  const { resolvedTheme } = useTheme();
  return useMemo(
    () =>
      htmlRenderTheme(
        resolvedTheme === "dark" ? T3_CODE_DARK_THEME_COLORS : T3_CODE_LIGHT_THEME_COLORS,
        resolvedTheme,
        HTML_RENDER_DEFAULT_FONTS,
      ),
    [resolvedTheme],
  );
}

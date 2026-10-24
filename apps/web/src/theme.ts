export type { ThemeAppearance } from "@cogenly/shared/themePalettes";
export type AppearanceMode = "light" | "dark" | "system";
export const THEME_APPEARANCE_MODE_STORAGE_KEY = "cogenly:theme-appearance-mode";
// Without a stored choice Cogenly starts dark. index.html's boot script mirrors this.
export const DEFAULT_APPEARANCE_MODE: AppearanceMode = "dark";
export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === "light" || value === "dark" || value === "system";
}

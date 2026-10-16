import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  DEFAULT_APPEARANCE_MODE,
  isAppearanceMode,
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  type AppearanceMode,
} from "../theme";
const listeners = new Set<() => void>();
function notify() {
  for (const listener of listeners) listener();
}
export function readThemePreference(): AppearanceMode {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE_MODE;
  try {
    const mode = window.localStorage.getItem(THEME_APPEARANCE_MODE_STORAGE_KEY);
    if (isAppearanceMode(mode)) return mode;
    const legacy = window.localStorage.getItem("cogenly:theme");
    return isAppearanceMode(legacy) ? legacy : DEFAULT_APPEARANCE_MODE;
  } catch {
    return DEFAULT_APPEARANCE_MODE;
  }
}
let removeBrowserListeners: (() => void) | undefined;
let appliedRoot: HTMLElement | undefined;
let appliedAppearance: string | undefined;
function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    window.addEventListener("storage", notify);
    media?.addEventListener("change", notify);
    removeBrowserListeners = () => {
      window.removeEventListener("storage", notify);
      media?.removeEventListener("change", notify);
    };
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      removeBrowserListeners?.();
      removeBrowserListeners = undefined;
    }
  };
}
export function useTheme() {
  const appearanceMode = useSyncExternalStore(
    subscribe,
    readThemePreference,
    () => DEFAULT_APPEARANCE_MODE,
  );
  const systemDark = useSyncExternalStore(
    subscribe,
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
    () => false,
  );
  const resolvedTheme =
    appearanceMode === "system" ? (systemDark ? "dark" : "light") : appearanceMode;
  const setAppearanceMode = useCallback((mode: AppearanceMode) => {
    try {
      window.localStorage.setItem(THEME_APPEARANCE_MODE_STORAGE_KEY, mode);
    } catch {
      return false;
    }
    notify();
    return true;
  }, []);
  useEffect(() => {
    if (appliedRoot === document.documentElement && appliedAppearance === resolvedTheme) return;
    appliedRoot = document.documentElement;
    appliedAppearance = resolvedTheme;
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
    document.documentElement.style.colorScheme = resolvedTheme;
    document.documentElement.dataset.themeSelected = "true";
    const color = getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim();
    for (const meta of document.querySelectorAll('meta[name="theme-color"]'))
      meta.setAttribute("content", color);
    void window.desktopBridge?.setTheme(resolvedTheme);
  }, [resolvedTheme]);
  return {
    theme: appearanceMode,
    appearanceMode,
    resolvedTheme,
    setAppearanceMode,
    setTheme: setAppearanceMode,
  } as const;
}

export function syncBrowserChromeTheme() {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return;
  const color = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
  for (const meta of document.querySelectorAll('meta[name="theme-color"]'))
    meta.setAttribute("content", color);
}

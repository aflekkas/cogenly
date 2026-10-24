import { APPEARANCE_ACCENTS, type AppearanceAccent } from "@t3tools/contracts";
import { useCallback, useSyncExternalStore } from "react";

/**
 * Device-local appearance preferences beside the color scheme (theme.ts):
 * accent color, font size and reduced motion. Stored in localStorage like the
 * color scheme and applied as attributes on <html> (data-accent,
 * data-font-size, data-reduce-motion), which index.css reads. index.html's
 * boot script applies the same attributes before first paint, so keep the
 * storage key and attribute names in sync with it. The desktop shell gets the
 * accent too, for its Dock icon.
 */
export const ACCENT_COLORS = APPEARANCE_ACCENTS;
export type AccentColor = AppearanceAccent;

export const FONT_SIZES = ["small", "default", "large"] as const;
export type FontSizePreference = (typeof FONT_SIZES)[number];

/** "system" follows the OS setting; "reduce" turns motion down regardless. */
export const MOTION_PREFERENCES = ["system", "reduce"] as const;
export type MotionPreference = (typeof MOTION_PREFERENCES)[number];

/**
 * What usage-limit bars fill with: "remaining" drains as quota is spent,
 * "used" fills up. Read by React only, so it sets no <html> attribute.
 */
export const USAGE_METER_MODES = ["remaining", "used"] as const;
export type UsageMeterMode = (typeof USAGE_METER_MODES)[number];

/**
 * Where the sidebar's search dock sits and which way its lists read: "top"
 * reads down from the dock under the titlebar; "bottom" docks search at the
 * foot of the column and stacks lists up toward it. Read by React only.
 */
export const SIDEBAR_LAYOUTS = ["top", "bottom"] as const;
export type SidebarLayout = (typeof SIDEBAR_LAYOUTS)[number];

export interface AppearancePreferences {
  readonly accent: AccentColor;
  readonly fontSize: FontSizePreference;
  readonly motion: MotionPreference;
  readonly usageMeter: UsageMeterMode;
  readonly sidebarLayout: SidebarLayout;
}

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  accent: "orange",
  fontSize: "default",
  motion: "system",
  usageMeter: "remaining",
  sidebarLayout: "bottom",
};

export const APPEARANCE_PREFERENCES_STORAGE_KEY = "cogenly:appearance-preferences";

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** Reads stored preferences, falling back per field so one bad value never resets the rest. */
export function parseAppearancePreferences(raw: string | null): AppearancePreferences {
  if (raw === null) return DEFAULT_APPEARANCE_PREFERENCES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_APPEARANCE_PREFERENCES;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_APPEARANCE_PREFERENCES;
  const record = parsed as Record<string, unknown>;
  return {
    accent: oneOf(ACCENT_COLORS, record.accent, DEFAULT_APPEARANCE_PREFERENCES.accent),
    fontSize: oneOf(FONT_SIZES, record.fontSize, DEFAULT_APPEARANCE_PREFERENCES.fontSize),
    motion: oneOf(MOTION_PREFERENCES, record.motion, DEFAULT_APPEARANCE_PREFERENCES.motion),
    usageMeter: oneOf(
      USAGE_METER_MODES,
      record.usageMeter,
      DEFAULT_APPEARANCE_PREFERENCES.usageMeter,
    ),
    sidebarLayout: oneOf(
      SIDEBAR_LAYOUTS,
      record.sidebarLayout,
      DEFAULT_APPEARANCE_PREFERENCES.sidebarLayout,
    ),
  };
}

/** The <html> attributes for a set of preferences; null removes the attribute (the default). */
export function appearanceRootAttributes(
  preferences: AppearancePreferences,
): Readonly<Record<"data-accent" | "data-font-size" | "data-reduce-motion", string | null>> {
  return {
    "data-accent": preferences.accent === "orange" ? null : preferences.accent,
    "data-font-size": preferences.fontSize === "default" ? null : preferences.fontSize,
    "data-reduce-motion": preferences.motion === "reduce" ? "" : null,
  };
}

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedPreferences = DEFAULT_APPEARANCE_PREFERENCES;

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(APPEARANCE_PREFERENCES_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function readAppearancePreferences(): AppearancePreferences {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE_PREFERENCES;
  const raw = readRaw();
  // A stable object per stored value keeps useSyncExternalStore from looping.
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedPreferences = parseAppearancePreferences(raw);
  }
  return cachedPreferences;
}

let sentDesktopAccent: AccentColor | undefined;

function applyToDocument(preferences: AppearancePreferences) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(appearanceRootAttributes(preferences))) {
    if (value === null) root.removeAttribute(name);
    else root.setAttribute(name, value);
  }
  // The desktop shell mirrors the accent into the macOS Dock icon and keeps it
  // for its next launch. Sent once per change; every window sends the same value.
  if (sentDesktopAccent !== preferences.accent) {
    sentDesktopAccent = preferences.accent;
    void window.desktopBridge?.setAccentColor?.(preferences.accent).catch(() => undefined);
  }
}

function notify() {
  applyToDocument(readAppearancePreferences());
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("storage", notify);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", notify);
  };
}

export function writeAppearancePreferences(patch: Partial<AppearancePreferences>): boolean {
  const next = { ...readAppearancePreferences(), ...patch };
  try {
    window.localStorage.setItem(APPEARANCE_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    return false;
  }
  notify();
  return true;
}

export function useAppearancePreferences() {
  const preferences = useSyncExternalStore(
    subscribe,
    readAppearancePreferences,
    () => DEFAULT_APPEARANCE_PREFERENCES,
  );
  const update = useCallback(
    (patch: Partial<AppearancePreferences>) => writeAppearancePreferences(patch),
    [],
  );
  return { preferences, update } as const;
}

/** The sidebar layout preference, live: the sidebar's shared pieces all read this one flag. */
export function useSidebarLayout(): SidebarLayout {
  return useSyncExternalStore(
    subscribe,
    () => readAppearancePreferences().sidebarLayout,
    () => DEFAULT_APPEARANCE_PREFERENCES.sidebarLayout,
  );
}

const REDUCED_MOTION_QUERY = /prefers-reduced-motion\s*:\s*(reduce|no-preference)/i;

/**
 * Applies the stored preferences and makes script motion checks honor the
 * Reduce motion override. Components check `matchMedia("(prefers-reduced-motion:
 * reduce)")` directly in many places; while the override is on, those queries
 * answer as if the OS asked for reduced motion. CSS follows through the
 * motion-reduce / motion-safe variants in index.css. Call once at startup.
 */
export function installAppearancePreferences() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  applyToDocument(readAppearancePreferences());
  const nativeMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = (query: string) => {
    const match = REDUCED_MOTION_QUERY.exec(query);
    if (match && readAppearancePreferences().motion === "reduce") {
      // "all" always matches and "not all" never does, so the list keeps a
      // real MediaQueryList shape while answering for the override.
      return nativeMatchMedia(match[1]?.toLowerCase() === "reduce" ? "all" : "not all");
    }
    return nativeMatchMedia(query);
  };
}

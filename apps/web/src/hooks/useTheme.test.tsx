// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { readThemePreference, useTheme } from "./useTheme";

const values = new Map<string, string>();
afterEach(() => {
  values.clear();
  vi.unstubAllGlobals();
});
function storage() {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
}
it("defaults to dark without a stored preference", () => {
  storage();
  expect(readThemePreference()).toBe("dark");
});
it("respects a stored system preference", () => {
  storage();
  values.set("cogenly:theme-appearance-mode", "system");
  expect(readThemePreference()).toBe("system");
});
it("ignores retired custom palettes and preserves legacy appearance modes", () => {
  storage();
  values.set("cogenly:theme", "ocean");
  expect(readThemePreference()).toBe("dark");
  values.set("cogenly:theme", "dark");
  expect(readThemePreference()).toBe("dark");
  values.set("cogenly:theme-appearance-mode", "light");
  expect(readThemePreference()).toBe("light");
});
it("follows system changes and persists an explicit mode", async () => {
  storage();
  values.set("cogenly:theme-appearance-mode", "system");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let dark = false;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({
    matches: dark,
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  }));
  let current: ReturnType<typeof useTheme> | undefined;
  function Probe() {
    current = useTheme();
    return null;
  }
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    await act(async () => root.render(<Probe />));
    expect(current?.resolvedTheme).toBe("light");
    await act(async () => {
      dark = true;
      for (const listener of listeners) listener();
    });
    expect(current?.resolvedTheme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await act(async () => {
      current?.setAppearanceMode("light");
    });
    expect(current?.resolvedTheme).toBe("light");
    expect(values.get("cogenly:theme-appearance-mode")).toBe("light");
  } finally {
    await act(async () => root.unmount());
  }
});

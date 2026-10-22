import type { DesktopDictationBridge } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { createDevDictationBridge } from "./devDictationBridge";

/** Set to "1" in localStorage on a dev build to try the composer UI with a canned transcript. */
export const DEV_DICTATION_MOCK_STORAGE_KEY = "cogenly:dev-dictation-mock";

let devBridge: DesktopDictationBridge | null = null;

export function readDictationBridge(): DesktopDictationBridge | null {
  const bridge = window.desktopBridge?.dictation;
  if (bridge) return bridge;
  if (import.meta.env.DEV && localStorage.getItem(DEV_DICTATION_MOCK_STORAGE_KEY) === "1") {
    devBridge ??= createDevDictationBridge();
    return devBridge;
  }
  return null;
}

let availability: Promise<boolean> | null = null;

/** False until the desktop shell confirms it can transcribe on device; web builds stay false. */
export function useDictationAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const bridge = readDictationBridge();
    if (!bridge) return;
    let live = true;
    availability ??= bridge.isAvailable().catch(() => false);
    void availability.then((value) => {
      if (live) setAvailable(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return available;
}

/** The OS locale; the packaged renderer's own `navigator.language` is pinned to en-US. */
export function dictationLocale(): string {
  return window.desktopBridge?.getSystemLocale?.() ?? navigator.language;
}

/**
 * The app surface (--background in apps/web/src/index.css) for a native
 * window's backdrop, so a window never flashes a lighter or darker band before
 * its page paints. Used by the main window and the preview's popup windows.
 */
export function windowBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#0d0d0f" : "#fcfcfc";
}

/** Mirrors document.hidden onto <html data-document-hidden>, so CSS can pause
 * ambient animations (the pixel button's working crawl) while the window is
 * hidden. Idempotent: a second call only re-syncs the attribute. */
export function installDocumentVisibilityAttribute(): void {
  const sync = () => {
    if (document.hidden) document.documentElement.dataset.documentHidden = "true";
    else delete document.documentElement.dataset.documentHidden;
  };
  if (!installed) {
    installed = true;
    document.addEventListener("visibilitychange", sync);
  }
  sync();
}

let installed = false;

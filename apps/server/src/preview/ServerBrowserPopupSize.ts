// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Observes extension content through Playwright callbacks.
import * as NodeCrypto from "node:crypto";
import type { Page } from "playwright-core";

interface PopupSize {
  readonly width: number;
  readonly height: number;
}

// Measure intrinsic document layout, temporarily removing the root's viewport
// constraint. A scrollWidth/scrollHeight measurement cannot shrink below the
// previous viewport and would feed the client's stream dimensions back into it.
const measureSource = `() => {
  const root = document.documentElement;
  if (!root || !document.body) return {width: 25, height: 25};
  const original = root.style.cssText;
  try {
    root.style.setProperty('width', 'max-content', 'important');
    root.style.setProperty('height', 'max-content', 'important');
    const width = Math.max(25, Math.min(800, Math.ceil(root.getBoundingClientRect().width)));
    root.style.setProperty('width', width + 'px', 'important');
    const height = Math.max(25, Math.min(600, Math.ceil(root.getBoundingClientRect().height)));
    return {width, height};
  } finally { root.style.cssText = original; }
}`;

export async function popupPreferredSize(page: Page): Promise<PopupSize> {
  await page.waitForLoadState("domcontentloaded");
  return page.evaluate<PopupSize>(`(${measureSource})()`);
}

/** Emits only content-derived changes. Viewer resizes never supply a preferred size. */
export async function watchPopupPreferredSize(
  page: Page,
  onSize: (size: PopupSize) => Promise<void>,
) {
  const key = `__cogenlyPopupSize_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
  let stopped = false;
  let pending: PopupSize | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let applying = false;
  let lastApplied = 0;
  const flush = async () => {
    timer = undefined;
    if (stopped || applying || !pending) return;
    const size = pending;
    pending = undefined;
    applying = true;
    try {
      await onSize(size);
    } catch {
      /* The page can close while resizing. */
    } finally {
      applying = false;
      lastApplied = Date.now();
      schedule();
    }
  };
  const schedule = () => {
    if (!stopped && pending && !applying && !timer)
      timer = setTimeout(() => void flush(), Math.max(0, 100 - (Date.now() - lastApplied)));
  };
  await page.exposeBinding(key, async (_source, value: unknown) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("width" in value) ||
      !("height" in value) ||
      typeof value.width !== "number" ||
      typeof value.height !== "number" ||
      !Number.isFinite(value.width) ||
      !Number.isFinite(value.height)
    )
      return;
    pending = {
      width: Math.max(25, Math.min(800, Math.ceil(value.width))),
      height: Math.max(25, Math.min(600, Math.ceil(value.height))),
    };
    schedule();
  });
  const install = () =>
    page.evaluate(`(() => {
    const key = ${JSON.stringify(key)};
    window[key + '_stop']?.();
    const measure = ${measureSource};
    let previous;
    let queued = false;
    let stopped = false;
    const observe = () => mutations.observe(document, {subtree:true, childList:true, characterData:true, attributes:true});
    const report = () => {
      queued = false;
      if (stopped) return;
      mutations.disconnect();
      const size = measure();
      observe();
      if (previous?.width === size.width && previous?.height === size.height) return;
      previous = size;
      void window[key](size).catch(() => {});
    };
    const schedule = () => { if (!queued && !stopped) { queued = true; requestAnimationFrame(report); } };
    const mutations = new MutationObserver(schedule);
    const resize = new ResizeObserver(schedule);
    resize.observe(document.documentElement);
    if (document.body) resize.observe(document.body);
    document.fonts?.addEventListener('loadingdone', schedule);
    window[key + '_stop'] = () => {
      stopped = true;
      mutations.disconnect();
      resize.disconnect();
      document.fonts?.removeEventListener('loadingdone', schedule);
    };
    report();
  })()`);
  const loaded = () => {
    void install().catch(() => {});
  };
  page.on("load", loaded);
  await install();
  return async () => {
    stopped = true;
    pending = undefined;
    clearTimeout(timer);
    page.off("load", loaded);
    await page.evaluate(`window[${JSON.stringify(key + "_stop")}]?.()`).catch(() => {});
  };
}

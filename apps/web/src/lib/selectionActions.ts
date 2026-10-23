export type SelectionActionPoint = { x: number; y: number };

export const SELECTION_MULTI_CLICK_INTERVAL_MS = 500;

export function resolveSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { right: number; bottom: number } | null;
  pointer: SelectionActionPoint | null;
  viewport: { width: number; height: number };
}): SelectionActionPoint {
  const { bounds, selectionRect, pointer, viewport } = options;
  const preferred = pointer ?? {
    x: selectionRect?.right ?? bounds.left + bounds.width - 140,
    y: selectionRect ? selectionRect.bottom + 4 : bounds.top + 12,
  };
  return {
    x: Math.max(
      8,
      Math.min(Math.max(bounds.left, preferred.x), bounds.left + bounds.width, viewport.width - 8),
    ),
    y: Math.max(
      8,
      Math.min(Math.max(bounds.top, preferred.y), bounds.top + bounds.height, viewport.height - 8),
    ),
  };
}

type SelectionLineRect = { left: number; right: number; top: number; bottom: number };

/**
 * Top-left corner for a floating action that must never cover the selected
 * text: centered under the selection's end, or above its start when the end
 * sits too close to the bottom of `bounds`. The pointer is ignored, so the
 * same selection always lands in the same place however it was made.
 * Zero-width line rects (a paragraph selection's trailing newline) are skipped.
 */
export function resolveSelectionPillPosition(options: {
  lines: ReadonlyArray<SelectionLineRect>;
  /** Horizontal extent the pill stays within, such as the message column. */
  column: { left: number; right: number };
  /** Visible area the pill stays within, such as the scroll viewport. */
  bounds: { top: number; bottom: number };
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  gap?: number;
  margin?: number;
}): SelectionActionPoint | null {
  const { column, bounds, size, viewport, gap = 6, margin = 8 } = options;
  const lines = options.lines.filter((line) => line.right - line.left > 0);
  const first = lines[0];
  const last = lines.at(-1);
  if (!first || !last) return null;
  const top = Math.max(bounds.top, 0) + margin;
  const bottom = Math.min(bounds.bottom, viewport.height) - margin;

  const below = last.bottom + gap;
  const above = first.top - gap - size.height;
  const placeBelow = below + size.height <= bottom || above < top;
  const anchorX = placeBelow ? last.right : first.left;
  const y = placeBelow ? Math.min(below, bottom - size.height) : above;

  const minX = Math.max(column.left, margin);
  const maxX = Math.min(column.right, viewport.width - margin) - size.width;
  const x = Math.max(minX, Math.min(anchorX - size.width / 2, maxX));
  return { x: Math.round(x), y: Math.round(Math.max(top, y)) };
}

/**
 * Opens selection actions after release, leaving multi-clicks time to finish.
 * DOM selections call selectionChanged; canvas selections can use their own
 * change notification. Each surface still owns reading and acting on its text.
 * Interactive popovers pass getActionElement to keep editing their fields from
 * replacing the captured source selection.
 */
export function observeSelectionActions({
  element,
  getActionElement,
  onSelection,
  onDismiss,
}: {
  element: HTMLElement;
  getActionElement?: () => HTMLElement | null;
  onSelection: (pointer: SelectionActionPoint | null) => void;
  onDismiss: (reason: "interaction" | "cancel") => void;
}) {
  const document = element.ownerDocument;
  const view = document.defaultView!;
  let pointerDown = false;
  let gestureActive = false;
  let dismissed = false;
  let pointer: SelectionActionPoint | null = null;
  let timer: number | null = null;
  let frame: number | null = null;

  const isActionTarget = (target: EventTarget | null) =>
    target !== null && (getActionElement?.()?.contains(target as Node) ?? false);

  const cancelPending = () => {
    if (timer !== null) view.clearTimeout(timer);
    if (frame !== null) view.cancelAnimationFrame(frame);
    timer = frame = null;
  };
  const cancel = () => {
    cancelPending();
    pointerDown = gestureActive = false;
    pointer = null;
    dismissed = true;
  };
  const dismiss = () => {
    cancel();
    onDismiss("cancel");
  };
  const onContextMenu = () => {
    cancel();
    onDismiss("interaction");
  };
  const schedule = (delay: number) => {
    cancelPending();
    timer = view.setTimeout(() => {
      timer = null;
      frame = view.requestAnimationFrame(() => {
        frame = null;
        onSelection(pointer);
      });
    }, delay);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    if (isActionTarget(event.target)) {
      cancel();
      return;
    }
    cancelPending();
    pointerDown = event.button === 0;
    const inside = element.contains(event.target as Node);
    gestureActive = false;
    dismissed = true;
    pointer = null;
    if (inside) onDismiss("interaction");
    else if (getActionElement?.()) onDismiss("cancel");
  };
  const onSelectionStart = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    const target = event.target as Element | null;
    // Buttons can preserve an existing text selection while opening a menu.
    // Their release must not reopen selection actions beside the button.
    if (target?.closest("button, [role=button]")) return;
    // A surface may consume a press for a link or terminal mouse reporting.
    gestureActive = event.button === 0 && !event.defaultPrevented;
    dismissed = !gestureActive;
  };
  const onPointerUp = (event: PointerEvent) => {
    // Preventing pointerdown (for example on a toolbar) can suppress mouseup.
    if (event.isPrimary && event.button === 0) pointerDown = false;
  };
  const onMouseUp = (event: MouseEvent) => {
    if (event.button !== 0) return;
    pointerDown = false;
    if (!gestureActive) return;
    gestureActive = false;
    pointer = { x: event.clientX, y: event.clientY };
    schedule(event.detail >= 2 ? SELECTION_MULTI_CLICK_INTERVAL_MS : 0);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (isActionTarget(event.target) && event.key !== "Escape") return;
    if (event.key === "Escape") {
      dismiss();
    } else if (!pointerDown) {
      cancelPending();
      gestureActive = false;
      pointer = null;
      dismissed = false;
    }
  };
  const onFocusIn = (event: FocusEvent) => {
    if (isActionTarget(event.target)) cancel();
    else if (!pointerDown && getActionElement?.()) dismiss();
  };
  const onScroll = () => {
    cancelPending();
    // Autoscroll during a drag must not cancel that gesture's eventual release.
    if (!pointerDown) {
      pointer = null;
      dismissed = true;
    }
    onDismiss("cancel");
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  element.addEventListener("pointerdown", onSelectionStart);
  view.addEventListener("pointerup", onPointerUp);
  view.addEventListener("mouseup", onMouseUp);
  view.addEventListener("pointercancel", dismiss);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("focusin", onFocusIn);
  element.addEventListener("contextmenu", onContextMenu, true);
  element.addEventListener("scroll", onScroll, true);
  view.addEventListener("blur", dismiss);
  view.addEventListener("resize", dismiss);

  return {
    get pending() {
      return timer !== null || frame !== null;
    },
    cancel,
    selectionChanged() {
      if (isActionTarget(document.activeElement)) return;
      if (pointerDown || gestureActive) {
        onDismiss("cancel");
      } else if (!dismissed && timer === null && frame === null) {
        schedule(0);
      }
    },
    dispose() {
      cancel();
      document.removeEventListener("pointerdown", onPointerDown, true);
      element.removeEventListener("pointerdown", onSelectionStart);
      view.removeEventListener("pointerup", onPointerUp);
      view.removeEventListener("mouseup", onMouseUp);
      view.removeEventListener("pointercancel", dismiss);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      element.removeEventListener("contextmenu", onContextMenu, true);
      element.removeEventListener("scroll", onScroll, true);
      view.removeEventListener("blur", dismiss);
      view.removeEventListener("resize", dismiss);
    },
  };
}

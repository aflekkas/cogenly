import type { ContextMenuItem } from "@t3tools/contracts";

import {
  MENU_VIEWPORT_MARGIN_PX,
  SUBMENU_ALIGN_OFFSET_PX,
  SUBMENU_SIDE_OFFSET_PX,
} from "./components/ui/menu-metrics";

const SVG_NS = "http://www.w3.org/2000/svg";

// Inline Lucide-style icon paths (stroke-based, viewBox 0 0 24 24, strokeWidth 2).
const ICON_PATHS: Record<string, ReadonlyArray<{ tag: string; attrs: Record<string, string> }>> = {
  archive: [
    { tag: "rect", attrs: { width: "20", height: "5", x: "2", y: "3", rx: "1" } },
    { tag: "path", attrs: { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" } },
    { tag: "path", attrs: { d: "M10 12h4" } },
  ],
  check: [{ tag: "path", attrs: { d: "M20 6 9 17l-5-5" } }],
  // A filled dot in the item's iconColor, such as a project color choice.
  swatch: [{ tag: "circle", attrs: { cx: "12", cy: "12", r: "7" } }],
  tag: [
    {
      tag: "path",
      attrs: {
        d: "M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z",
      },
    },
    { tag: "circle", attrs: { cx: "7.5", cy: "7.5", r: ".5" } },
  ],
  timer: [
    { tag: "line", attrs: { x1: "10", x2: "14", y1: "2", y2: "2" } },
    { tag: "line", attrs: { x1: "12", x2: "15", y1: "14", y2: "11" } },
    { tag: "circle", attrs: { cx: "12", cy: "14", r: "8" } },
  ],
  "timer-off": [
    { tag: "path", attrs: { d: "M10 2h4" } },
    { tag: "path", attrs: { d: "M4.6 11a8 8 0 0 0 1.7 8.7 8 8 0 0 0 8.7 1.7" } },
    { tag: "path", attrs: { d: "M7.4 7.4a8 8 0 0 1 10.3 1 8 8 0 0 1 .9 10.2" } },
    { tag: "path", attrs: { d: "m2 2 20 20" } },
    { tag: "path", attrs: { d: "M12 12v-2" } },
  ],
  "chevron-right": [{ tag: "path", attrs: { d: "m9 19 7-7-7-7" } }],
  "circle-check": [
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
    { tag: "path", attrs: { d: "m9 12 2 2 4-4" } },
  ],
  code: [
    { tag: "path", attrs: { d: "m16 18 6-6-6-6" } },
    { tag: "path", attrs: { d: "m8 6-6 6 6 6" } },
  ],
  clock: [
    { tag: "path", attrs: { d: "M12 6v6l4 2" } },
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
  ],
  pencil: [
    {
      tag: "path",
      attrs: {
        d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
      },
    },
    { tag: "path", attrs: { d: "m15 5 4 4" } },
  ],
  copy: [
    { tag: "rect", attrs: { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" } },
    { tag: "path", attrs: { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" } },
  ],
  folder: [
    {
      tag: "path",
      attrs: {
        d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
      },
    },
  ],
  "git-branch": [
    { tag: "line", attrs: { x1: "6", x2: "6", y1: "3", y2: "15" } },
    { tag: "circle", attrs: { cx: "18", cy: "6", r: "3" } },
    { tag: "circle", attrs: { cx: "6", cy: "18", r: "3" } },
    { tag: "path", attrs: { d: "M18 9a9 9 0 0 1-9 9" } },
  ],
  hammer: [
    { tag: "path", attrs: { d: "m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9" } },
    { tag: "path", attrs: { d: "m18 15 4-4" } },
    {
      tag: "path",
      attrs: {
        d: "m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5",
      },
    },
  ],
  hash: [
    { tag: "line", attrs: { x1: "4", x2: "20", y1: "9", y2: "9" } },
    { tag: "line", attrs: { x1: "4", x2: "20", y1: "15", y2: "15" } },
    { tag: "line", attrs: { x1: "10", x2: "8", y1: "3", y2: "21" } },
    { tag: "line", attrs: { x1: "16", x2: "14", y1: "3", y2: "21" } },
  ],
  link: [
    { tag: "path", attrs: { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" } },
    { tag: "path", attrs: { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" } },
  ],
  mail: [
    { tag: "rect", attrs: { width: "20", height: "16", x: "2", y: "4", rx: "2" } },
    { tag: "path", attrs: { d: "m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" } },
  ],
  "mail-open": [
    {
      tag: "path",
      attrs: {
        d: "M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6Z",
      },
    },
    { tag: "path", attrs: { d: "m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10" } },
  ],
  "message-square-plus": [
    {
      tag: "path",
      attrs: {
        d: "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
      },
    },
    { tag: "path", attrs: { d: "M12 8v6" } },
    { tag: "path", attrs: { d: "M9 11h6" } },
  ],
  pin: [
    { tag: "path", attrs: { d: "M12 17v5" } },
    {
      tag: "path",
      attrs: {
        d: "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
      },
    },
  ],
  "pin-off": [
    { tag: "path", attrs: { d: "M12 17v5" } },
    { tag: "path", attrs: { d: "M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" } },
    { tag: "path", attrs: { d: "m2 2 20 20" } },
    {
      tag: "path",
      attrs: {
        d: "M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11",
      },
    },
  ],
  "refresh-cw": [
    { tag: "path", attrs: { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" } },
    { tag: "path", attrs: { d: "M21 3v5h-5" } },
    { tag: "path", attrs: { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" } },
    { tag: "path", attrs: { d: "M8 16H3v5" } },
  ],
  settings: [
    {
      tag: "path",
      attrs: {
        d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
      },
    },
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "3" } },
  ],
  "folder-tree": [
    {
      tag: "path",
      attrs: {
        d: "M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z",
      },
    },
    {
      tag: "path",
      attrs: {
        d: "M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z",
      },
    },
    { tag: "path", attrs: { d: "M3 5a2 2 0 0 0 2 2h3" } },
    { tag: "path", attrs: { d: "M3 3v13a2 2 0 0 0 2 2h3" } },
  ],
  trash: [
    { tag: "path", attrs: { d: "M3 6h18" } },
    { tag: "path", attrs: { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" } },
    { tag: "path", attrs: { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" } },
    { tag: "line", attrs: { x1: "10", x2: "10", y1: "11", y2: "17" } },
    { tag: "line", attrs: { x1: "14", x2: "14", y1: "11", y2: "17" } },
  ],
};

function createIconElement(name: string, tone: "neutral" | "destructive"): SVGSVGElement | null {
  const paths = ICON_PATHS[name];
  if (!paths || typeof document.createElementNS !== "function") {
    return null;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("viewBox", "0 0 24 24");
  const filled = name === "swatch";
  svg.setAttribute("fill", filled ? "currentColor" : "none");
  svg.setAttribute("stroke", filled ? "none" : "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute(
    "class",
    tone === "destructive"
      ? "size-4.5 shrink-0 sm:size-3.5"
      : "size-4.5 shrink-0 text-muted-foreground sm:size-3.5",
  );
  for (const node of paths) {
    const child = document.createElementNS(SVG_NS, node.tag);
    for (const [key, value] of Object.entries(node.attrs)) {
      child.setAttribute(key, value);
    }
    svg.appendChild(child);
  }
  return svg;
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const MENU_EXIT_MS = 90;

// The same open and close motion as the app's dropdown menus and popovers: a small scale and a
// fade from the point the menu grew out of, quick to leave. Reduced motion fades only.
function openMotionMs(): number {
  const ms = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--motion-duration-fast"),
  );
  return Number.isFinite(ms) ? ms : 150;
}

function animateMenuIn(menu: HTMLElement) {
  if (typeof menu.animate !== "function") return;
  const reduced = window.matchMedia(REDUCED_MOTION).matches;
  menu.animate(
    reduced
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { opacity: 0, transform: "scale(0.97)" },
          { opacity: 1, transform: "scale(1)" },
        ],
    { duration: openMotionMs(), easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "backwards" },
  );
}

function removeMenuAnimated(menu: HTMLElement) {
  if (!menu.isConnected) return;
  // It no longer takes part in the menu stack; keep it from catching the pointer while it leaves.
  menu.style.pointerEvents = "none";
  menu.inert = true;
  if (typeof menu.animate !== "function") {
    menu.remove();
    return;
  }
  const reduced = window.matchMedia(REDUCED_MOTION).matches;
  const leave = menu.animate(
    reduced
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0, transform: "scale(0.97)" },
        ],
    { duration: MENU_EXIT_MS, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
  );
  void leave.finished.then(
    () => menu.remove(),
    () => menu.remove(),
  );
}

/**
 * Where a menu opens, and where it goes instead when that would cross the
 * viewport's right or bottom edge: a right-click menu opens left of or above
 * the cursor, a submenu on the parent's other side or rising from its trigger.
 */
export interface MenuPlacement {
  readonly left: number;
  readonly top: number;
  readonly flippedLeft: (width: number) => number;
  readonly flippedTop: (height: number) => number;
}

function clampToViewport(value: number, size: number, viewport: number): number {
  const margin = MENU_VIEWPORT_MARGIN_PX;
  return Math.min(Math.max(margin, value), Math.max(margin, viewport - size - margin));
}

/**
 * Where a menu of `size` lands in `viewport`: on its flipped side when it
 * would cross an edge and fits there, then kept clear of every edge.
 */
export function resolveMenuPosition(
  placement: MenuPlacement,
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): { left: number; top: number } {
  const margin = MENU_VIEWPORT_MARGIN_PX;
  // Flip only to a side the menu fits on; otherwise stay and shift inward.
  const axis = (preferred: number, flipped: number, extent: number, limit: number) =>
    preferred + extent <= limit - margin || flipped < margin ? preferred : flipped;
  const left = axis(placement.left, placement.flippedLeft(size.width), size.width, viewport.width);
  const top = axis(placement.top, placement.flippedTop(size.height), size.height, viewport.height);
  return {
    left: clampToViewport(left, size.width, viewport.width),
    top: clampToViewport(top, size.height, viewport.height),
  };
}

function placeMenu(menu: HTMLDivElement, placement: MenuPlacement) {
  // Layout size, not getBoundingClientRect: the opening scale would shrink it.
  const size = { width: menu.offsetWidth, height: menu.offsetHeight };
  const { left, top } = resolveMenuPosition(placement, size, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  return { left, top, ...size };
}

function isNodeWithinMenuStack(target: EventTarget | null, menuStack: readonly HTMLDivElement[]) {
  if (typeof Node !== "undefined" && target instanceof Node) {
    return menuStack.some((menu) => menu.contains(target));
  }
  if (!target || typeof target !== "object") {
    return false;
  }

  let current: unknown = target;
  while (current && typeof current === "object") {
    if (menuStack.includes(current as HTMLDivElement)) {
      return true;
    }
    current = (current as { parent?: unknown }).parent;
  }
  return false;
}

// Only one fallback menu exists at a time in the renderer; the active one is
// tracked so a state change (for example a terminal selection clearing) can
// dismiss it with the same result as an outside click or Escape.
let activeContextMenuDismiss: (() => void) | null = null;

export function isContextMenuOpen(): boolean {
  return activeContextMenuDismiss !== null;
}

/**
 * Closes the currently open fallback context menu, resolving its show() with
 * null (the same result as dismissing by outside click or Escape). No-op when
 * no fallback menu is open.
 */
export function dismissContextMenu(): void {
  activeContextMenuDismiss?.();
  activeContextMenuDismiss = null;
}

/**
 * Imperative DOM-based context menu for non-Electron environments.
 * Supports nested submenus and resolves with the clicked leaf item id.
 */
export function showContextMenuFallback<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const previouslyFocusedElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menuStack: HTMLDivElement[] = [];
    const submenuTriggerStack: Array<HTMLButtonElement | undefined> = [];
    let isDisposed = false;
    let canDismissFromPointer = false;

    const dismiss = () => cleanup(null);

    const cleanup = (result: T | null) => {
      if (isDisposed) {
        return;
      }
      isDisposed = true;
      if (activeContextMenuDismiss === dismiss) {
        activeContextMenuDismiss = null;
      }
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
      const shouldRestoreFocus = isNodeWithinMenuStack(document.activeElement, menuStack);
      for (const menu of menuStack) {
        removeMenuAnimated(menu);
      }
      if (shouldRestoreFocus && previouslyFocusedElement?.isConnected) {
        previouslyFocusedElement.focus({ preventScroll: true });
      }
      resolve(result);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup(null);
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!canDismissFromPointer || isNodeWithinMenuStack(event.target, menuStack)) {
        return;
      }
      cleanup(null);
    };

    const onContextMenu = (event: MouseEvent) => {
      if (!canDismissFromPointer || isNodeWithinMenuStack(event.target, menuStack)) {
        return;
      }
      event.preventDefault();
      cleanup(null);
    };

    const closeMenusFromLevel = (level: number) => {
      while (menuStack.length > level) {
        submenuTriggerStack.pop()?.setAttribute("aria-expanded", "false");
        const closing = menuStack.pop();
        if (closing) removeMenuAnimated(closing);
      }
    };

    const openMenu = (
      entries: readonly ContextMenuItem<T>[],
      placement: MenuPlacement,
      level: number,
      /** Where the menu grows from: the cursor for a right-click, the trigger for a submenu. */
      anchor: { x: number; y: number },
      parentTrigger?: HTMLButtonElement,
    ) => {
      closeMenusFromLevel(level);

      const menu = document.createElement("div");
      menu.className =
        "dropdown-glass surface-raised surface-raised-floating fixed z-[10000] min-w-32 max-w-sm overflow-hidden rounded-lg bg-clip-padding text-popover-foreground outline-none";
      menu.style.cssText =
        "position:fixed;z-index:10000;min-width:8rem;max-width:24rem;overflow:hidden;border-radius:var(--radius-lg);background-clip:padding-box;color:var(--contrast-popover-foreground);outline:none;pointer-events:auto;";
      menu.dataset.level = String(level);

      const inner = document.createElement("div");
      // Fit the viewport minus its margins, so a menu only scrolls when the
      // window is shorter than the menu itself.
      const maxHeight = `calc(100vh - ${MENU_VIEWPORT_MARGIN_PX * 2}px)`;
      inner.className = "min-w-0 max-w-sm overflow-y-auto overflow-x-hidden p-1";
      inner.style.cssText = `max-height:${maxHeight};min-width:0;max-width:24rem;overflow-x:hidden;overflow-y:auto;padding:0.25rem;`;

      for (const item of entries) {
        if (item.separatorBefore === true && inner.children.length > 0) {
          const separator = document.createElement("div");
          separator.className = "mx-2 my-1 h-px bg-border";
          separator.style.cssText =
            "height:1px;margin:0.25rem 0.5rem;background:var(--contrast-border);";
          separator.dataset.contextMenuSeparator = "true";
          separator.setAttribute("role", "separator");
          inner.appendChild(separator);
        }

        if (item.header === true) {
          const header = document.createElement("div");
          header.className = "px-2 py-1.5 font-medium text-muted-foreground text-xs";
          header.textContent = item.label;
          inner.appendChild(header);
          continue;
        }

        const hasChildren = Array.isArray(item.children) && item.children.length > 0;
        const isLeafDestructive =
          !hasChildren && (item.destructive === true || item.id === ("delete" as T));

        const button = document.createElement("button");
        button.type = "button";
        const isDisabled = item.disabled === true;
        button.disabled = isDisabled;
        const rowBase =
          "flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-left outline-none transition-colors sm:min-h-6.5 sm:text-menu min-h-8 text-base";
        button.className = isDisabled
          ? `${rowBase} pointer-events-none cursor-not-allowed text-muted-foreground opacity-64`
          : isLeafDestructive
            ? `${rowBase} text-destructive-foreground interactive hover:bg-destructive/10 hover:text-destructive-foreground`
            : `${rowBase} text-foreground state-hover`;
        button.style.cssText =
          "display:flex;width:100%;min-height:1.625rem;align-items:center;gap:0.5rem;border:0;border-radius:var(--radius-sm);background:transparent;padding:0.25rem 0.5rem;color:var(--contrast-foreground);font-family:var(--font-sans,system-ui,sans-serif);font-size:0.8125rem;line-height:1.125rem;text-align:left;cursor:default;";
        if (isLeafDestructive) {
          button.style.color = "var(--destructive-foreground)";
        } else if (!isDisabled) {
          // Plain rows take the shared state-hover surface via data-highlighted.
          button.style.removeProperty("background");
          button.style.removeProperty("color");
        }
        if (isDisabled) {
          button.style.color = "var(--contrast-muted-foreground)";
          button.style.opacity = "0.64";
          button.style.pointerEvents = "none";
        }

        // An option with its own icon (a project's folder) keeps the icon in
        // the slot and moves its check to the end of the row.
        const trailingCheck = typeof item.checked === "boolean" && typeof item.icon === "string";
        if (trailingCheck) {
          button.setAttribute("role", "menuitemradio");
          button.setAttribute("aria-checked", item.checked ? "true" : "false");
          const icon = createIconElement(item.icon!, "neutral");
          if (icon) {
            if (item.iconColor) icon.style.color = item.iconColor;
            button.appendChild(icon);
          }
        } else if (typeof item.checked === "boolean") {
          // Option rows use the icon slot for the check so labels line up
          // with icon rows. The unselected option keeps the slot empty.
          button.setAttribute("role", "menuitemradio");
          button.setAttribute("aria-checked", item.checked ? "true" : "false");
          const check = item.checked ? createIconElement("check", "neutral") : null;
          if (check) {
            button.appendChild(check);
          } else {
            const spacer = document.createElement("span");
            spacer.className = "size-4.5 shrink-0 sm:size-3.5";
            spacer.style.cssText =
              "display:inline-block;width:0.875rem;height:0.875rem;flex-shrink:0;";
            spacer.setAttribute("aria-hidden", "true");
            button.appendChild(spacer);
          }
        } else if (typeof item.icon === "string") {
          const icon = createIconElement(item.icon, isLeafDestructive ? "destructive" : "neutral");
          if (icon) {
            if (item.iconColor) icon.style.color = item.iconColor;
            button.appendChild(icon);
          }
        }

        const label = document.createElement("span");
        label.className = "min-w-0 flex-1 truncate";
        label.textContent = item.label;
        button.appendChild(label);
        if (trailingCheck && item.checked) {
          const check = createIconElement("check", "neutral");
          if (check) {
            check.setAttribute(
              "class",
              "ms-auto size-4.5 shrink-0 text-muted-foreground sm:size-3.5",
            );
            button.appendChild(check);
          }
        }

        if (hasChildren) {
          button.setAttribute("aria-haspopup", "menu");
          button.setAttribute("aria-expanded", "false");
          const chevron = createIconElement("chevron-right", "neutral");
          if (chevron) {
            chevron.setAttribute(
              "class",
              "-me-0.5 ms-auto size-4.5 shrink-0 text-muted-foreground opacity-80 sm:size-3.5",
            );
            chevron.setAttribute("aria-hidden", "true");
            chevron.dataset.contextMenuChevron = "true";
            button.appendChild(chevron);
          }
        }

        if (!isDisabled) {
          let isHovered = false;
          let isFocused = false;
          const updateHighlight = () => {
            const isHighlighted = isHovered || isFocused;
            button.toggleAttribute("data-highlighted", isHighlighted);
            if (isLeafDestructive) {
              button.style.background = isHighlighted
                ? "color-mix(in srgb, var(--destructive) 10%, transparent)"
                : "transparent";
            }
          };
          button.addEventListener("mouseenter", () => {
            button.focus({ preventScroll: true });
            isHovered = true;
            updateHighlight();
          });
          button.addEventListener("mouseleave", () => {
            isHovered = false;
            updateHighlight();
          });
          button.addEventListener("focus", () => {
            isFocused = true;
            updateHighlight();
          });
          button.addEventListener("blur", () => {
            isFocused = false;
            updateHighlight();
          });

          if (hasChildren) {
            const openSubmenu = (focusFirstItem = false) => {
              const rect = button.getBoundingClientRect();
              // The first item lines up with the trigger row and the submenu
              // tucks over the parent's edge; near the bottom it rises from
              // the trigger instead, its last item level with the row.
              openMenu(
                item.children!,
                {
                  left: rect.right + SUBMENU_SIDE_OFFSET_PX,
                  top: rect.top + SUBMENU_ALIGN_OFFSET_PX,
                  flippedLeft: (width) => rect.left - width - SUBMENU_SIDE_OFFSET_PX,
                  flippedTop: (height) => rect.bottom - height - SUBMENU_ALIGN_OFFSET_PX,
                },
                level + 1,
                { x: rect.right, y: rect.top + rect.height / 2 },
                button,
              );
              button.setAttribute("aria-expanded", "true");

              const childMenu = menuStack[level + 1];
              if (!childMenu) {
                return;
              }
              if (focusFirstItem) {
                [...childMenu.querySelectorAll<HTMLButtonElement>("button")]
                  .find((childButton) => !childButton.disabled)
                  ?.focus();
              }
            };
            button.addEventListener("mouseenter", () => {
              openSubmenu();
            });
            button.addEventListener("click", (event) => {
              event.preventDefault();
              openSubmenu(true);
            });
          } else {
            button.addEventListener("mouseenter", () => {
              closeMenusFromLevel(level + 1);
            });
            button.addEventListener("click", () => {
              if (canDismissFromPointer) cleanup(item.id);
            });
          }
        }

        inner.appendChild(button);
      }

      menu.appendChild(inner);

      menu.addEventListener("mouseenter", () => {
        closeMenusFromLevel(level + 1);
      });

      document.body.appendChild(menu);
      menuStack[level] = menu;
      submenuTriggerStack[level] = parentTrigger;

      const placed = placeMenu(menu, placement);
      const originX = Math.min(Math.max(anchor.x - placed.left, 0), placed.width);
      const originY = Math.min(Math.max(anchor.y - placed.top, 0), placed.height);
      menu.style.transformOrigin = `${originX}px ${originY}px`;
      animateMenuIn(menu);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    const x = position?.x ?? 0;
    const y = position?.y ?? 0;
    openMenu(
      items,
      { left: x, top: y, flippedLeft: (width) => x - width, flippedTop: (height) => y - height },
      0,
      { x, y },
    );
    // Only one fallback menu can be open at a time: a new show must dismiss
    // any prior one, or its DOM and listeners leak and close() can only ever
    // reach the newest menu.
    if (activeContextMenuDismiss) {
      activeContextMenuDismiss();
    }
    activeContextMenuDismiss = dismiss;

    requestAnimationFrame(() => {
      canDismissFromPointer = true;
    });
  });
}

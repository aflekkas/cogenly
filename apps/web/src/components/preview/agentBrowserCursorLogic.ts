export type BrowserController = "human" | "agent" | "none";

/**
 * Full while the agent acts. Between actions it stays readable while the agent
 * still drives the tab, so viewers see what it points at, and nearly fades once
 * someone else has control.
 */
export function agentBrowserCursorOpacity(active: boolean, controller: BrowserController): number {
  if (active) return 1;
  if (controller === "agent") return 0.6;
  return controller === "human" ? 0.18 : 0.35;
}

/** How long the target outline shows before it has faded out. */
export const AGENT_TARGET_OUTLINE_MS = 600;

/** A rectangle in viewport CSS pixels, as the server reports the element acted on. */
export interface AgentTargetBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where the agent acts, as reported: a viewport point and the element it acts on, if any. */
export interface AgentPointerTarget {
  readonly phase: "move" | "click";
  readonly x: number;
  readonly y: number;
  readonly box?: AgentTargetBox | null | undefined;
}

/** A surface position, in the CSS pixels of the element the cursor is drawn over. */
export interface AgentSurfaceRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Maps page viewport pixels onto a surface: `surface = offset + page * scale`. */
export interface AgentSurfaceFrame {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

/**
 * The frame for a page drawn into a box with `object-fit: cover` anchored at
 * the top: it fills the width or height, centered across, cropped at the bottom.
 */
export function coverTopFrame(
  page: { readonly width: number; readonly height: number },
  box: { readonly width: number; readonly height: number },
): AgentSurfaceFrame | null {
  if (page.width <= 0 || page.height <= 0) return null;
  const scale = Math.max(box.width / page.width, box.height / page.height);
  return {
    offsetX: (box.width - page.width * scale) / 2,
    offsetY: 0,
    scaleX: scale,
    scaleY: scale,
  };
}

/** The frame for a page letterboxed into a box with `object-fit: contain`. */
export function containFrame(
  page: { readonly width: number; readonly height: number },
  box: { readonly width: number; readonly height: number },
): AgentSurfaceFrame | null {
  if (page.width <= 0 || page.height <= 0) return null;
  const scale = Math.min(box.width / page.width, box.height / page.height);
  return {
    offsetX: (box.width - page.width * scale) / 2,
    offsetY: (box.height - page.height * scale) / 2,
    scaleX: scale,
    scaleY: scale,
  };
}

/** One frame after another: maps through `inner` first, then `outer`. */
export function composeFrames(
  inner: AgentSurfaceFrame,
  outer: AgentSurfaceFrame,
): AgentSurfaceFrame {
  return {
    offsetX: outer.offsetX + inner.offsetX * outer.scaleX,
    offsetY: outer.offsetY + inner.offsetY * outer.scaleY,
    scaleX: inner.scaleX * outer.scaleX,
    scaleY: inner.scaleY * outer.scaleY,
  };
}

/**
 * Places the agent's cursor on a surface. The outline marks the element only as
 * the cursor arrives on it (`move`); the click that follows on the same element
 * shows its ripple instead of a second outline.
 */
export function placeAgentTarget(
  target: AgentPointerTarget,
  frame: AgentSurfaceFrame,
): { readonly left: number; readonly top: number; readonly outline: AgentSurfaceRect | null } {
  const box = target.box;
  const outlined =
    target.phase === "move" && box != null && box.width > 0 && box.height > 0 ? box : null;
  return {
    left: frame.offsetX + target.x * frame.scaleX,
    top: frame.offsetY + target.y * frame.scaleY,
    outline: outlined
      ? {
          left: frame.offsetX + outlined.x * frame.scaleX,
          top: frame.offsetY + outlined.y * frame.scaleY,
          width: outlined.width * frame.scaleX,
          height: outlined.height * frame.scaleY,
        }
      : null,
  };
}

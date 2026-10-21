export interface PanelHeight {
  /** The content's measured border-box height, in px. */
  readonly height: number;
  /** False for the first measurement after mount or reopen, which must not animate. */
  readonly animate: boolean;
}

/**
 * The panel height after the content measured `measured` px. A zero size means
 * the content is hidden or detached (a keepMounted popup that closed), so the
 * panel returns to its natural height and the next size it gets is a first one.
 * An unchanged size keeps the previous value so React can skip the render.
 */
export function nextPanelHeight(
  previous: PanelHeight | null,
  measured: number,
): PanelHeight | null {
  if (!(measured > 0)) return null;
  if (previous?.height === measured) return previous;
  return { height: measured, animate: previous !== null };
}

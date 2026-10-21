export type PreviewController = "agent" | "you" | "another-viewer" | "unclaimed";

export interface PreviewControlToggleState {
  /** Pressed means the page is in someone else's hands (or nobody's), not yours. */
  readonly pressed: boolean;
  /** Set while you drive: there is nothing to hand back. */
  readonly disabled: boolean;
  /** The tooltip and accessible name: who drives, and what a click does. */
  readonly hint: string;
}

/**
 * The toolbar's control toggle, from the stream's controller. A click only
 * ever takes control, which interrupts whatever the agent or another viewer
 * was doing. There is no way to hand the page back: the agent takes control
 * again the next time it acts.
 */
export function resolvePreviewControlToggle(
  controller: PreviewController,
): PreviewControlToggleState {
  switch (controller) {
    case "you":
      return { pressed: false, disabled: true, hint: "You have control" };
    case "agent":
      return { pressed: true, disabled: false, hint: "Agent has control · click to take over" };
    case "unclaimed":
      return { pressed: true, disabled: false, hint: "Nobody has control · click to take it" };
    case "another-viewer":
      return {
        pressed: true,
        disabled: false,
        hint: "Another viewer has control · click to take over",
      };
  }
}

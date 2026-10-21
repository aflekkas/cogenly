export type PreviewController = "agent" | "you" | "another-viewer" | "unclaimed";

export interface PreviewControlToggleState {
  /** Pressed means the page is in the agent's hands (or nobody's), not yours. */
  readonly pressed: boolean;
  readonly disabled: boolean;
  /** The tooltip and accessible name: who drives, and what a click does. */
  readonly hint: string;
  /** What a click asks the server for. */
  readonly next: "you" | "agent" | null;
}

/**
 * The toolbar's control toggle, from the stream's controller. A click always
 * flips who drives: taking control interrupts the agent, handing it back
 * lets the agent act again. On a tab an agent opened, "handed back" shows as
 * the agent driving even between its actions; on a tab a person opened it is
 * simply nobody's until someone takes it.
 */
export function resolvePreviewControlToggle(
  controller: PreviewController,
): PreviewControlToggleState {
  switch (controller) {
    case "you":
      return {
        pressed: false,
        disabled: false,
        hint: "You have control · click to hand the page to the agent",
        next: "agent",
      };
    case "agent":
      return {
        pressed: true,
        disabled: false,
        hint: "Agent has control · click to take over",
        next: "you",
      };
    case "unclaimed":
      return {
        pressed: true,
        disabled: false,
        hint: "Nobody has control · click to take it",
        next: "you",
      };
    case "another-viewer":
      return {
        pressed: false,
        disabled: true,
        hint: "Another viewer has control",
        next: null,
      };
  }
}

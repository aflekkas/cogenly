export type PreviewController = "agent" | "you" | "another-viewer" | "unclaimed";

export interface PreviewControlInput {
  readonly controller: PreviewController;
  readonly canOperate: boolean;
  /** An agent opened or has used the tab, so control can go back to it. */
  readonly agentInvolved: boolean;
}

export type PreviewControlToggleState =
  | { readonly kind: "hidden" }
  | { readonly kind: "readOnly" }
  | {
      readonly kind: "agent";
      /** Pressed while the agent drives; a click takes control. */
      readonly pressed: boolean;
      /** Off while another viewer drives: take control from the page banner first. */
      readonly disabled: boolean;
      readonly action: "take" | "handBack" | null;
      /** The tooltip and accessible name: who drives, and what a click does. */
      readonly hint: string;
    };

/**
 * The toolbar's agent toggle for a streamed tab. Pressed means the agent
 * drives: a click takes control. Released means you drive a tab an agent was
 * using: a click hands it back. A tab no agent has touched needs no toggle.
 */
export function resolvePreviewControlToggle(input: PreviewControlInput): PreviewControlToggleState {
  if (!input.canOperate) return { kind: "readOnly" };
  switch (input.controller) {
    case "agent":
      return {
        kind: "agent",
        pressed: true,
        disabled: false,
        action: "take",
        hint: "Agent is driving · click to take control",
      };
    case "you":
      return input.agentInvolved
        ? {
            kind: "agent",
            pressed: false,
            disabled: false,
            action: "handBack",
            hint: "You're driving · click to hand back to the agent",
          }
        : { kind: "hidden" };
    case "another-viewer":
      return input.agentInvolved
        ? {
            kind: "agent",
            pressed: false,
            disabled: true,
            action: null,
            hint: "Another viewer is driving",
          }
        : { kind: "hidden" };
    case "unclaimed":
      return { kind: "hidden" };
  }
}

/**
 * The line over the page while someone else (or nobody) drives a tab you may
 * operate; it carries the one-click Take control. Null while you drive or can
 * only watch.
 */
export function resolvePreviewControlBanner(input: PreviewControlInput): string | null {
  if (!input.canOperate) return null;
  switch (input.controller) {
    case "you":
      return null;
    case "agent":
      return "Agent is driving";
    case "another-viewer":
      return "Another viewer is driving";
    case "unclaimed":
      return "Nobody is driving";
  }
}

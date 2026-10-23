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

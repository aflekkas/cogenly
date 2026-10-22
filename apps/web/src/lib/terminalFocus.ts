export type TerminalFocusOwner = "bottom-panel";

export function getTerminalFocusOwner(): TerminalFocusOwner | null {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return null;
  if (!activeElement.isConnected) return null;
  const owner = activeElement.closest<HTMLElement>("[data-terminal-owner]")?.dataset.terminalOwner;
  return owner === "bottom-panel" ? owner : null;
}

export function isTerminalFocused(): boolean {
  return getTerminalFocusOwner() !== null;
}

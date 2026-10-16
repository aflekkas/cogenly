import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "../rightPanelStore";

/** Reveal an existing terminal in the right panel's Terminal surface, without opening another PTY. */
export function revealThreadTerminal(threadRef: ScopedThreadRef, terminalId: string) {
  useRightPanelStore.getState().openTerminal(threadRef, terminalId);
}

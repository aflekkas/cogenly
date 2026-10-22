import type { ScopedThreadRef } from "@t3tools/contracts";

import { useBottomPanelStore } from "../bottomPanelStore";

/**
 * Open a thread's bottom panel on one of its agent's commands, without
 * opening another PTY. A user action: nothing calls this when a run starts.
 */
export function revealThreadTerminal(threadRef: ScopedThreadRef, terminalId: string) {
  useBottomPanelStore.getState().showRun(threadRef, threadRef.threadId, terminalId);
}

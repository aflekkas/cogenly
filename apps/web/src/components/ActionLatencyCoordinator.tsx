import { useEffect, useSyncExternalStore } from "react";

import { useThreadShells } from "../state/entities";
import {
  finishStoppedThreadActionsAfterPaint,
  hasPendingStop,
  subscribePendingActions,
} from "../observability/actionLatency";

/** Stop can be triggered for a thread outside the current chat view. */
export function ActionLatencyCoordinator() {
  const stopping = useSyncExternalStore(subscribePendingActions, hasPendingStop);
  const threads = useThreadShells(stopping);
  useEffect(() => {
    if (stopping)
      finishStoppedThreadActionsAfterPaint(
        threads.map((thread) => ({ ...thread.source, environmentId: thread.environmentId })),
      );
  }, [stopping, threads]);
  return null;
}

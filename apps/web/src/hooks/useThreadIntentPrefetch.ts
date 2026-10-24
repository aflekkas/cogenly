import type { ScopedThreadRef } from "@t3tools/contracts";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useMemo, useRef } from "react";

import { createThreadIntent } from "../state/threadPrefetch";

/**
 * Row handlers that start loading a thread once the pointer rests on its row
 * or keyboard focus stays on it. Spread onto the element that opens it.
 */
export function useThreadIntentPrefetch(threadRef: ScopedThreadRef | null) {
  const refRef = useRef(threadRef);
  useEffect(() => {
    refRef.current = threadRef;
  }, [threadRef]);
  const intent = useMemo(() => createThreadIntent(() => refRef.current), []);
  useEffect(() => intent.cancel, [intent]);
  return useMemo(
    () => ({
      onPointerEnter: (event: ReactPointerEvent) => intent.begin(event.pointerType),
      onPointerLeave: intent.cancel,
      onFocus: () => intent.begin(null),
      onBlur: intent.cancel,
    }),
    [intent],
  );
}

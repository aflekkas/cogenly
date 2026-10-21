import { useCallback, useRef, useState } from "react";

/**
 * An element held in state through a callback ref, for effects that observe
 * it. A view hidden by `<Activity>` has its refs detached but keeps its DOM;
 * keeping that still-connected element means neither hiding nor revealing the
 * view re-renders it (and nothing measuring it starts from no element). An
 * element that really left the DOM is dropped once the commit has removed it.
 */
export function useElementState<T extends Element>(): [
  element: T | null,
  attach: (element: T | null) => void,
] {
  const [element, setElement] = useState<T | null>(null);
  const attachedRef = useRef<T | null>(null);
  const attach = useCallback((next: T | null) => {
    if (next !== null) {
      attachedRef.current = next;
      setElement(next);
      return;
    }
    const detached = attachedRef.current;
    if (detached === null) return;
    // Refs detach before the commit removes the node; check once it has.
    queueMicrotask(() => {
      if (attachedRef.current !== detached || detached.isConnected) return;
      attachedRef.current = null;
      setElement(null);
    });
  }, []);
  return [element, attach];
}

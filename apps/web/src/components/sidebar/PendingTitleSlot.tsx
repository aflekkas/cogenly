import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

/** Matches the layers' --motion-duration-fast, the crossfade's length. */
const LANDING_MS = 150;
const layerClassName =
  "col-start-1 row-start-1 min-w-0 transition-opacity duration-(--motion-duration-fast) ease-standard";

/**
 * A row title that is still being generated (a new chat's first title, or a
 * regeneration). While pending, the text the caller passes (the provisional
 * title, such as the first message or "New thread") shows dimmed, as T3 Code
 * does; there is no skeleton and nothing animates while it waits. When the
 * title lands, the dimmed text crossfades into the new title (opacity only,
 * 150ms, kept under reduced motion). Both layers sit in one grid cell, so the
 * row keeps its height and layout and nothing moves.
 *
 * Pass the title's layout classes (`min-w-0 flex-1`) in `className`.
 */
export function PendingTitleSlot(props: {
  pending: boolean;
  className?: string;
  children: ReactNode;
}) {
  const pendingChildrenRef = useRef<ReactNode>(null);
  const wasPendingRef = useRef(props.pending);
  // Each landing remounts the live layer so it fades in from transparent.
  const [landingCount, setLandingCount] = useState(0);
  const [outgoing, setOutgoing] = useState<{ node: ReactNode } | null>(null);

  useLayoutEffect(() => {
    if (props.pending) pendingChildrenRef.current = props.children;
  });

  useLayoutEffect(() => {
    const wasPending = wasPendingRef.current;
    wasPendingRef.current = props.pending;
    if (props.pending || !wasPending) return;
    setLandingCount((count) => count + 1);
    setOutgoing({ node: pendingChildrenRef.current });
    const timer = setTimeout(() => setOutgoing(null), LANDING_MS);
    return () => clearTimeout(timer);
  }, [props.pending]);

  return (
    <span className={cn("grid", props.className)}>
      <span
        key={landingCount}
        className={cn(
          layerClassName,
          landingCount > 0 && "starting:opacity-0",
          props.pending && "opacity-55",
        )}
      >
        {props.children}
      </span>
      {outgoing && !props.pending ? (
        <span
          aria-hidden
          inert
          className={cn(layerClassName, "pointer-events-none opacity-0 starting:opacity-55")}
        >
          {outgoing.node}
        </span>
      ) : null}
      {props.pending ? (
        <span role="status" className="sr-only">
          Generating title
        </span>
      ) : null}
    </span>
  );
}

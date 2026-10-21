import { useEffect, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Skeleton } from "../ui/skeleton";

/** Matches --motion-duration-base, the crossfade's length. */
const SKELETON_EXIT_MS = 220;
const layerClassName =
  "col-start-1 row-start-1 min-w-0 transition-opacity duration-(--motion-duration-base) ease-standard";

/**
 * A row title that is still being generated (a new chat's first title, or a
 * regeneration) shows a skeleton bar in its place; when the title lands the
 * bar crossfades into the text. Both sit in one grid cell, so the title keeps
 * the row's height and layout and nothing moves. The skeleton is only
 * mounted while pending (and for its fade out), so idle rows run no
 * animation; under reduced motion it holds still (Skeleton's motion-safe).
 *
 * Pass the title's layout classes (`min-w-0 flex-1`) in `className`.
 */
export function PendingTitleSlot(props: {
  pending: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [skeletonLingers, setSkeletonLingers] = useState(props.pending);
  useEffect(() => {
    if (props.pending) {
      setSkeletonLingers(true);
      return;
    }
    const timer = setTimeout(() => setSkeletonLingers(false), SKELETON_EXIT_MS);
    return () => clearTimeout(timer);
  }, [props.pending]);

  return (
    <span className={cn("grid items-center", props.className)}>
      <span className={cn(layerClassName, props.pending && "opacity-0")}>{props.children}</span>
      {props.pending || skeletonLingers ? (
        <span
          aria-hidden
          className={cn(
            layerClassName,
            "flex items-center starting:opacity-0",
            props.pending ? "opacity-100" : "opacity-0",
          )}
        >
          <Skeleton shape="pill" className="h-2 w-2/3" />
        </span>
      ) : null}
    </span>
  );
}

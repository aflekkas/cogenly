import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

/**
 * Eases its width to its content's, so a control whose content swaps (a label
 * becoming an icon stack) glides instead of snapping. It measures the content
 * and transitions an explicit width; the first measure lands without motion.
 * Pass `animate={false}` for a change the user did not make, such as a thread
 * switch. Reduced motion snaps.
 */
export function AnimatedWidth(props: {
  readonly children: ReactNode;
  readonly animate?: boolean;
  readonly className?: string;
}) {
  const contentRef = useRef<HTMLSpanElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => setWidth(content.getBoundingClientRect().width);
    measure();
    return observeResize(content, measure);
  }, []);
  return (
    <span
      data-slot="animated-width"
      className={cn(
        // The vertical bleed keeps rings and focus outlines inside from clipping.
        "relative -my-0.5 inline-flex min-w-0 items-center overflow-hidden py-0.5",
        width !== null &&
          props.animate !== false &&
          "transition-[width] duration-(--motion-duration-base) ease-out motion-reduce:transition-none",
        props.className,
      )}
      style={width === null ? undefined : { width }}
    >
      <span ref={contentRef} className="inline-flex w-max shrink-0 items-center">
        {props.children}
      </span>
    </span>
  );
}

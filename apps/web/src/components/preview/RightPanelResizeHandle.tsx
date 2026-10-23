import type { ResizableWidthHandlers } from "~/hooks/useResizableWidth";
import { EdgeResizeHandle } from "../EdgeResizeHandle";

interface Props {
  handlers: ResizableWidthHandlers;
  className?: string;
}

/** Hit target for resizing a right-anchored panel via its left edge. */
export function RightPanelResizeHandle({ handlers, className }: Props) {
  return <EdgeResizeHandle edge="left" handlers={handlers} className={className} />;
}

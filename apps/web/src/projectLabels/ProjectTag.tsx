import type { CSSProperties } from "react";

import { Badge } from "../components/ui/badge";
import { cn } from "../lib/utils";
import { projectLabelColorValue } from "./projectLabels.logic";

/** A project shown as a tag. Suggested tags are outlined until the user confirms them. */
export function ProjectTag(props: {
  name: string;
  color: string | undefined;
  suggested?: boolean;
  className?: string;
}) {
  return (
    <Badge
      variant={props.suggested ? "label-suggested" : "label"}
      size="sm"
      className={cn("min-w-0 max-w-28", props.className)}
      style={{ "--label": projectLabelColorValue(props.color) } as CSSProperties}
    >
      <span className="min-w-0 truncate">{props.name}</span>
    </Badge>
  );
}

/** The project's color as a small dot, for lists and headings. */
export function ProjectColorDot(props: { color: string | undefined; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full bg-(--label)", props.className)}
      style={{ "--label": projectLabelColorValue(props.color) } as CSSProperties}
    />
  );
}

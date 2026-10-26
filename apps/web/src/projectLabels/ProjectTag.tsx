import { XIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { Badge } from "../components/ui/badge";
import { cn } from "../lib/utils";
import { projectLabelColorValue } from "./projectLabels.logic";

/**
 * A project shown as a tag. Suggested tags are outlined until the user
 * confirms them. `dot` leads with the color dot, for dense rows where the
 * tint alone reads faintly. `onRemove` makes the whole tag a button that
 * removes it, with a trailing ×, as a filter's chip.
 */
export function ProjectTag(props: {
  name: string;
  color: string | undefined;
  suggested?: boolean;
  dot?: boolean;
  onRemove?: (() => void) | undefined;
  /** The remove button's accessible name; required with `onRemove`. */
  removeLabel?: string | undefined;
  className?: string;
}) {
  return (
    <Badge
      variant={props.suggested ? "label-suggested" : "label"}
      size="sm"
      className={cn("min-w-0 max-w-28", props.className)}
      style={{ "--label": projectLabelColorValue(props.color) } as CSSProperties}
      {...(props.onRemove
        ? {
            render: <button type="button" aria-label={props.removeLabel} />,
            onClick: props.onRemove,
          }
        : {})}
    >
      {props.dot ? <ProjectColorDot color={props.color} className="size-1.5" /> : null}
      <span className="min-w-0 truncate">{props.name}</span>
      {props.onRemove ? <XIcon aria-hidden /> : null}
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

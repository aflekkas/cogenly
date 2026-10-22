import { FolderIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { cn } from "../lib/utils";
import { projectLabelColorValue } from "./projectLabels.logic";

// Sized to the capitals of the hero sentence and resting on its baseline.
export const HERO_INLINE_ICON_STYLE: CSSProperties = {
  width: "0.78em",
  height: "0.78em",
  verticalAlign: "-0.06em",
  marginInlineEnd: "0.28em",
};

/** A folder icon in the project's color, where a project is named in a line of text. */
export function ProjectFolderIcon(props: {
  color: string | undefined;
  className?: string;
  /** For icons sized in em to running text, as in the hero sentence. */
  style?: CSSProperties;
}) {
  return (
    <FolderIcon
      aria-hidden
      className={cn("size-3 shrink-0 text-(--label)", props.className)}
      style={{ ...props.style, "--label": projectLabelColorValue(props.color) } as CSSProperties}
    />
  );
}

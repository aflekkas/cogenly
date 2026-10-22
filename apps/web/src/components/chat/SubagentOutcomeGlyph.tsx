import { CheckIcon, CircleSlashIcon, XIcon } from "lucide-react";

import type { SubagentOutcome } from "./subagentRow.logic";

/**
 * The row's fixed status column. Working rows leave it empty, since the title
 * shimmer already says so; a settled row gets one quiet glyph.
 */
export function SubagentOutcomeGlyph({ outcome }: { outcome: SubagentOutcome }) {
  switch (outcome) {
    case "done":
      return <CheckIcon aria-hidden className="size-3 text-success" />;
    case "failed":
      return <XIcon aria-hidden className="size-3 text-destructive" />;
    case "stopped":
      return <CircleSlashIcon aria-hidden className="size-3 text-icon-muted" />;
    case "working":
    case "idle":
      return null;
  }
}

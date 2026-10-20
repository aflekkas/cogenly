import { CheckIcon } from "lucide-react";

import { Badge } from "../ui/badge";

/** Marks an interactive render whose result was submitted and locked. */
export function HtmlRenderSubmittedBadge() {
  return (
    <Badge variant="success" size="sm">
      <CheckIcon />
      Submitted
    </Badge>
  );
}

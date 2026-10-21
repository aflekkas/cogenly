import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A list column with nothing to show: the list's glyph (the mode's, or the
 * Work filter segment's) above a line of muted copy and any action, centred
 * in the column like the Agents empty state. It fades and rises in on mount,
 * so switching to an empty filter eases in instead of popping.
 */
export function SidebarListEmptyState(props: { icon: LucideIcon; children: ReactNode }) {
  const Icon = props.icon;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground reveal-motion">
      <Icon aria-hidden className="size-5 text-muted-foreground/50" />
      {props.children}
    </div>
  );
}

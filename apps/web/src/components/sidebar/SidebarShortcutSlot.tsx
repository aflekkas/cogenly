import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Kbd } from "../ui/kbd";
import { useLastPresent } from "../ui/overlay-presence";

const fadeClassName = "transition-opacity duration-(--motion-duration-fast) ease-standard";

/** Keeps metadata in layout while its shortcut takes over the trailing slot. */
export function SidebarShortcutSlot({
  label,
  children,
}: {
  label: string | null;
  children: ReactNode;
}) {
  const paintedLabel = useLastPresent(label);
  const visible = label !== null;
  return (
    <span className="relative inline-flex min-h-4 min-w-8 shrink-0 items-center justify-end">
      <span
        inert={visible}
        className={cn(
          "inline-flex min-w-0 items-center justify-end gap-1.5",
          fadeClassName,
          visible ? "opacity-0" : "opacity-100",
        )}
      >
        {children}
      </span>
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 flex items-center justify-end",
          fadeClassName,
          visible ? "opacity-100" : "opacity-0",
        )}
      >
        <Kbd variant="outline" size="sm">
          {paintedLabel}
        </Kbd>
      </span>
    </span>
  );
}

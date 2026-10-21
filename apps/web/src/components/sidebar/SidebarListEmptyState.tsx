import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A sidebar list with nothing to show (Chats, Work and its filters, Agents,
 * Projects): the list's glyph over one muted line, an optional dimmer second
 * line, then any action. Give it the list's remaining height (a `flex-1`
 * parent): it centres in the space between the list's top and the dock below,
 * lifted a little above true centre, the same in every mode. It fades in place
 * on mount (opacity only), so switching to an empty filter eases instead of
 * popping.
 */
export function SidebarListEmptyState(props: {
  icon: LucideIcon;
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <div
      data-sidebar-empty-state
      className="flex min-h-0 flex-1 flex-col items-center px-2 py-4 text-center reveal-motion"
    >
      {/* Unequal spacers (44% above, 56% below) give the optical lift: about
          6% above the centre of the free space, at any list height. */}
      <span aria-hidden className="grow-11" />
      <Icon aria-hidden className="size-5 shrink-0 text-muted-foreground opacity-65" />
      <p className="mt-2.5 text-xs text-muted-foreground">{props.label}</p>
      {props.description ? (
        <p className="mt-1 text-2xs text-muted-foreground/70">{props.description}</p>
      ) : null}
      {props.children ? (
        <div className="mt-3 flex flex-col items-center gap-2">{props.children}</div>
      ) : null}
      <span aria-hidden className="grow-14" />
    </div>
  );
}

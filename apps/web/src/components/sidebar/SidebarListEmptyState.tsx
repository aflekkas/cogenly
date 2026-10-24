import type { ReactNode } from "react";

/**
 * A sidebar list with nothing to show (Chats, Work, Agents, Projects): one
 * quiet line, and an optional action read as part of it ("No chats yet ·
 * New chat"). Filters never land here (an empty filter cannot be chosen, see
 * `useSegmentSelection`); only a list with nothing at all does. Give it the
 * list's remaining height (a `flex-1` parent): it centres in the space between
 * the dock above and the column's bottom, lifted a little above true centre, the
 * same in every mode. It fades in place on mount (opacity only).
 */
export function SidebarListEmptyState(props: {
  label: ReactNode;
  action?: { readonly label: string; readonly onClick: () => void } | undefined;
}) {
  return (
    <div
      data-sidebar-empty-state
      className="flex min-h-0 flex-1 flex-col items-center px-2 py-4 text-center reveal-motion"
    >
      {/* Unequal spacers (44% above, 56% below) give the optical lift: about
          6% above the centre of the free space, at any list height. */}
      <span aria-hidden className="grow-11" />
      <p className="text-xs text-muted-foreground">
        {props.label}
        {props.action ? (
          <>
            <span aria-hidden className="mx-1.5 text-muted-foreground/50">
              ·
            </span>
            <button
              type="button"
              onClick={props.action.onClick}
              className="cursor-pointer rounded-sm font-medium text-sidebar-foreground/80 outline-none transition-colors duration-(--motion-duration-fast) ease-standard hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
            >
              {props.action.label}
            </button>
          </>
        ) : null}
      </p>
      <span aria-hidden className="grow-14" />
    </div>
  );
}

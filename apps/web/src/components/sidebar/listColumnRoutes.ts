/**
 * Full-width pages: with the nav rail there to navigate away, these routes
 * have no sidebar list column. The toggle keeps its place but is disabled, and
 * its shortcut does nothing. Projects pages keep the column: the Projects
 * list is the way to pick one. The mobile sheet
 * keeps the list, since it is the only way back there. The Agents index and the
 * agent builder with nothing to list (`agentsEmpty`) are full-width too: the empty
 * state lives in the main pane, and the column returns with the first agent.
 */
export function routeHidesListColumn(
  pathname: string,
  context: { readonly agentsEmpty: boolean } = { agentsEmpty: false },
): boolean {
  return (
    pathname === "/usage" ||
    ((pathname === "/" || pathname === "/agents/new") && context.agentsEmpty)
  );
}

/** Why the sidebar toggle is disabled on a route without the list column. */
export const SIDEBAR_TOGGLE_DISABLED_LABEL = "Nothing to show in the sidebar here";

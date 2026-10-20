/**
 * Full-width pages: with the nav rail there to navigate away, these routes
 * have no sidebar list column (and so no toggle for it). The mobile sheet
 * keeps the list, since it is the only way back there. The Agents index with
 * nothing to list (`agentsEmpty`) is full-width too: its empty state lives in
 * the main pane, and the column returns with the first agent.
 */
export function routeHidesListColumn(
  pathname: string,
  context: { readonly agentsEmpty: boolean } = { agentsEmpty: false },
): boolean {
  return (
    pathname === "/usage" ||
    pathname === "/project" ||
    pathname.startsWith("/project/") ||
    (pathname === "/" && context.agentsEmpty)
  );
}

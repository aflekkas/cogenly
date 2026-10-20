/**
 * Full-width pages: with the nav rail there to navigate away, these routes
 * have no sidebar list column (and so no toggle for it). The mobile sheet
 * keeps the list, since it is the only way back there.
 */
export function routeHidesListColumn(pathname: string): boolean {
  return pathname === "/usage" || pathname === "/project" || pathname.startsWith("/project/");
}

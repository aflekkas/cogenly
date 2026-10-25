import { type ComponentProps, useRef } from "react";

import { useSidebarLayout } from "~/appearancePreferences";
import { SidebarGroup } from "../ui/sidebar";
import type { SidebarListEdge } from "./sidebarListAnchor.logic";
import { useSidebarListAnchor } from "./useSidebarListAnchor";

/**
 * The scrolling column under (or over) the search dock that every sidebar
 * list sits in: the main sidebar's modes and search, and Settings' sections
 * and search. It fills the scroll area, so in the bottom layout its items
 * stack up against the dock with the empty space above them, and it holds the
 * list's scroll against `edge` (`useSidebarListAnchor`): a "bottom" list opens
 * on the items nearest the dock. `listKey` names the list, so each keeps its
 * own place.
 */
export function SidebarListColumn({
  listKey,
  edge,
  ...props
}: Omit<ComponentProps<typeof SidebarGroup>, "ref" | "className"> & {
  listKey: string;
  edge: SidebarListEdge;
}) {
  const layout = useSidebarLayout();
  const ref = useRef<HTMLDivElement | null>(null);
  useSidebarListAnchor(ref, listKey, edge);
  return (
    <SidebarGroup
      {...props}
      ref={ref}
      role="presentation"
      // The same fill as `sidebarFillClassName`, spelled out for the class lint.
      className={layout === "bottom" ? "flex-1 justify-end" : "flex-1"}
    />
  );
}

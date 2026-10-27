import { type ComponentProps, useRef } from "react";

import { SidebarGroup } from "../ui/sidebar";
import { useSidebarListAnchor, useSidebarListEdge } from "./useSidebarListAnchor";

/**
 * The scrolling column under (or over) the search dock that every sidebar
 * list sits in: the main sidebar's modes, shelves and search, and Settings'
 * sections and search. It fills the scroll area and aligns its rows against
 * the dock's edge (`useSidebarListEdge`), the same for every list, so none
 * can sit apart. It holds the list's scroll against that edge
 * (`useSidebarListAnchor`): a "bottom" list opens on the items nearest the
 * dock. `listKey` names the list, so each keeps its own place. Callers draw
 * their rows from the dock outward (`drawFromDock`).
 */
export function SidebarListColumn({
  listKey,
  ...props
}: Omit<ComponentProps<typeof SidebarGroup>, "ref" | "className"> & {
  listKey: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const edge = useSidebarListEdge();
  useSidebarListAnchor(ref, listKey, edge);
  return (
    <SidebarGroup
      {...props}
      ref={ref}
      role="presentation"
      // The same fill as `sidebarFillClassName`, spelled out for the class lint.
      className={edge === "bottom" ? "flex-1 justify-end" : "flex-1"}
    />
  );
}

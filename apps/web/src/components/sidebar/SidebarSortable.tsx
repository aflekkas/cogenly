import {
  closestCenter,
  DndContext,
  type Active,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type Over,
  type SensorDescriptor,
  type SensorOptions,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useMemo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { SidebarFoldRow } from "./SidebarList";

/**
 * The sidebar's sortable cards (Work's, and the Agents list's): a press that
 * moves picks a card up, the card lifts and follows the pointer up and down
 * while its group's other cards slide out of its way, and the drop glides it
 * into its slot. Cards only ever land among their own group's cards. Sort
 * with `SidebarSortSensor` (Sidebar.pointer.ts) inside a `SidebarSortContext`.
 */

/** How far a press travels before it picks a card up, as the sidebar's other drags. */
export const SIDEBAR_SORT_DISTANCE = 6;

/** Held to the column: up and down only, inside the scrolling list. */
export const SIDEBAR_SORT_MODIFIERS = [restrictToVerticalAxis, restrictToFirstScrollableAncestor];

/**
 * The list scrolls only when a card is held right at its top or bottom edge
 * (dnd-kit's default reaches a fifth of the viewport in, which in a list that
 * fills from the bottom is most of the cards). Layout-shift compensation is
 * off: it scrolls the whole column to chase a card whose box moved as the
 * drag began, which reads as the list jumping.
 */
const SIDEBAR_SORT_AUTO_SCROLL = {
  threshold: { x: 0, y: 0.08 },
  layoutShiftCompensation: false,
} as const;

// --motion-duration-base on ease-standard: the cards a drag passes slide aside.
const SIDEBAR_SORT_TRANSITION = { duration: 220, easing: "cubic-bezier(0.32, 0.72, 0, 1)" };
const SIDEBAR_SORT_LIFT_TRANSITION =
  "filter var(--motion-duration-fast) var(--motion-ease-standard)";

/**
 * One sortable card's wiring: spread `listeners` on the element `setNodeRef`
 * points at, with `style` and `className`. A card that cannot move holds a
 * disabled slot, so one that becomes sortable keeps its place and state.
 */
export function useSidebarSortableItem(input: {
  readonly id: string;
  readonly sortable: boolean;
  readonly reducedMotion: boolean;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging, isSorting } = useSortable({
    id: input.id,
    disabled: !input.sortable,
    // Reduced motion: neighbours step aside without travelling.
    transition: input.reducedMotion ? null : SIDEBAR_SORT_TRANSITION,
  });
  // The dropped card stays above its neighbours until it settles into its slot.
  const raised = isDragging || (!isSorting && transform !== null);
  return {
    listeners,
    setNodeRef,
    isDragging,
    style: {
      transform: CSS.Translate.toString(transform),
      transition: transition
        ? `${transition}, ${SIDEBAR_SORT_LIFT_TRANSITION}`
        : SIDEBAR_SORT_LIFT_TRANSITION,
    },
    // The lift is a shadow on the slot: the card's own box clips paint.
    className: cn(raised && "relative z-20", isDragging && "cursor-grabbing drop-shadow-lg"),
  };
}

/**
 * A sortable card under a collapsible group heading (Work's project groups):
 * it folds with the heading, and sorts as `useSidebarSortableItem` describes.
 */
export function SidebarSortableFoldRow(props: {
  id: string;
  open: boolean;
  sortable: boolean;
  reducedMotion: boolean;
  children: ReactNode;
}) {
  const { listeners, setNodeRef, style, className } = useSidebarSortableItem(props);
  return (
    <SidebarFoldRow
      {...listeners}
      ref={setNodeRef}
      open={props.open}
      density="cards"
      style={style}
      className={className}
    >
      {props.children}
    </SidebarFoldRow>
  );
}

/**
 * Closest-center collision held to the dragged card's group: `groupOf` names
 * a card's group by its id, and a card only ever lands among its group's cards.
 */
export function sidebarGroupCollision(
  groupOf: (id: string) => string | undefined,
): CollisionDetection {
  return (args) => {
    const group = groupOf(String(args.active.id));
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (container) => groupOf(String(container.id)) === group,
      ),
    });
  };
}

/**
 * The dnd-kit context a sidebar list's cards sort in: held to the column's
 * vertical axis, with spoken announcements, and the grabbing cursor on every
 * surface for the whole drag (`html[data-sidebar-sorting]` in index.css).
 */
export function SidebarSortContext(props: {
  sensors: SensorDescriptor<SensorOptions>[];
  collisionDetection: CollisionDetection;
  onDragStart?: ((event: DragStartEvent) => void) | undefined;
  onDragEnd: (event: DragEndEvent) => void;
  /** A card's spoken name for drag announcements (its title), from its id. */
  describe: (id: UniqueIdentifier) => string;
  children: ReactNode;
}) {
  const { describe } = props;
  const accessibility = useMemo(
    () => ({
      announcements: {
        onDragStart: ({ active }: { active: Active }) => `Picked up ${describe(active.id)}.`,
        onDragOver: ({ active, over }: { active: Active; over: Over | null }) =>
          over ? `${describe(active.id)} is over ${describe(over.id)}.` : undefined,
        onDragEnd: ({ active, over }: { active: Active; over: Over | null }) =>
          over
            ? `${describe(active.id)} dropped over ${describe(over.id)}.`
            : `${describe(active.id)} dropped.`,
        onDragCancel: ({ active }: { active: Active }) =>
          `Moving ${describe(active.id)} was cancelled.`,
      },
    }),
    [describe],
  );
  // A list torn down mid-drag must not leave the grabbing cursor behind.
  useEffect(() => () => document.documentElement.removeAttribute("data-sidebar-sorting"), []);
  return (
    <DndContext
      sensors={props.sensors}
      collisionDetection={props.collisionDetection}
      modifiers={SIDEBAR_SORT_MODIFIERS}
      autoScroll={SIDEBAR_SORT_AUTO_SCROLL}
      accessibility={accessibility}
      onDragStart={(event) => {
        // The grabbing cursor holds for the whole drag, wherever the pointer goes.
        document.documentElement.dataset.sidebarSorting = "";
        props.onDragStart?.(event);
      }}
      onDragEnd={(event) => {
        delete document.documentElement.dataset.sidebarSorting;
        props.onDragEnd(event);
      }}
      onDragCancel={() => {
        delete document.documentElement.dataset.sidebarSorting;
      }}
    >
      {props.children}
    </DndContext>
  );
}

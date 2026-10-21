import type { SidebarThreadMode } from "./components/sidebar/modes/sidebarModes.logic";
import type { ThreadRouteTarget } from "./threadRoutes";

/**
 * One thread view per sidebar mode stays mounted, and one per mode for its
 * draft, so switching between Chats, Work and Agents (or between a mode's
 * draft and the thread last opened there) reveals the view that showed it
 * instead of mounting a new one. Within a slot a view takes the next thread
 * exactly as the single view always has: server threads reuse one instance,
 * each draft gets its own.
 */
export type ThreadViewSlot = SidebarThreadMode | `${SidebarThreadMode}:draft`;

export const THREAD_VIEW_SLOTS: ReadonlyArray<ThreadViewSlot> = [
  "chats",
  "chats:draft",
  "tasks",
  "tasks:draft",
  "agents",
  "agents:draft",
];

/** The slot a thread (or a draft) of this mode goes to. */
export function threadViewSlotFor(
  mode: SidebarThreadMode,
  target: ThreadRouteTarget,
): ThreadViewSlot {
  return target.kind === "draft" ? `${mode}:draft` : mode;
}

export interface ThreadViewSlotEntry {
  readonly key: string;
  readonly target: ThreadRouteTarget;
}

export interface ThreadViewSlots {
  readonly active: ThreadViewSlot | null;
  readonly entries: Readonly<Partial<Record<ThreadViewSlot, ThreadViewSlotEntry>>>;
}

export const EMPTY_THREAD_VIEW_SLOTS: ThreadViewSlots = { active: null, entries: {} };

export function threadRouteTargetKey(target: ThreadRouteTarget): string {
  return target.kind === "server"
    ? `server:${target.threadRef.environmentId}:${target.threadRef.threadId}`
    : `draft:${target.draftId}`;
}

/** The slot holding the thread with this key, if one does. */
export function slotHolding(slots: ThreadViewSlots, key: string): ThreadViewSlot | null {
  return THREAD_VIEW_SLOTS.find((slot) => slots.entries[slot]?.key === key) ?? null;
}

/**
 * Puts the route's thread in a slot and makes that slot the shown one. A
 * thread a slot already holds stays there, whatever its mode reads now, so its
 * view is reused. Otherwise it goes to its mode's slot; a thread whose mode is
 * not known yet (`slotFor` returns null) stays in the shown slot, which keeps
 * a draft's view across its promotion. Returns `slots` itself when nothing
 * changes.
 */
export function placeThreadRouteTarget(
  slots: ThreadViewSlots,
  entry: ThreadViewSlotEntry,
  slotFor: () => ThreadViewSlot | null,
): ThreadViewSlots {
  const holding = slotHolding(slots, entry.key);
  if (holding !== null) {
    return holding === slots.active ? slots : { ...slots, active: holding };
  }
  const slot = slotFor() ?? slots.active ?? "chats";
  return { active: slot, entries: { ...slots.entries, [slot]: entry } };
}

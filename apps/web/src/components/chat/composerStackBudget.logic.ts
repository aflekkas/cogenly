/**
 * Height budgeting for the panels stacked above the composer (queue, tasks,
 * notices, background work, pending questions). The stack may take about a
 * third of the chat pane; past that, open lists scroll inside their panels,
 * and when even that leaves a list too short to read, the least important
 * open list folds to its header. A panel that needs the user's answer is
 * `blocking` and never shrinks or folds.
 */

export type ComposerStackPanelKind = "blocking" | "list" | "notice";

export interface ComposerStackPanel {
  readonly id: string;
  readonly kind: ComposerStackPanelKind;
  /** Higher stays open longer when lists have to fold. */
  readonly rank: number;
  /** The user reopened this list after it folded: it scrolls, however short, but stays open. */
  readonly pinned?: boolean;
  /** Height the panel takes with its list hidden: header, padding, and any fixed rows. */
  readonly chromeHeight: number;
  /** The open list's full content height; 0 when the panel has no list or the user closed it. */
  readonly bodyHeight: number;
}

export interface ComposerStackBudget {
  /** Lists folded down to their header to fit the cap. */
  readonly folded: ReadonlySet<string>;
  /** Max height for each open list; empty when everything fits. */
  readonly bodyMax: ReadonlyMap<string, number>;
}

/** Share of the chat pane the whole stack may cover. */
export const COMPOSER_STACK_PANE_SHARE = 1 / 3;
/** A list scrolled shorter than this (about three rows) is not worth keeping open. */
export const MIN_SCROLLING_LIST_HEIGHT = 72;
/** Notices beyond the most important one fold into a "+N more" bar from this many on. */
export const NOTICE_FOLD_THRESHOLD = 3;

const NO_FOLDS: ReadonlySet<string> = new Set();
const NO_LIMITS: ReadonlyMap<string, number> = new Map();

export function composerStackCap(paneHeight: number): number {
  return Math.max(0, Math.floor(paneHeight * COMPOSER_STACK_PANE_SHARE));
}

/**
 * Splits `room` between lists: each gets an equal share, and a list shorter
 * than its share gives the rest back to the taller ones.
 */
function shareRoom(lists: ReadonlyArray<ComposerStackPanel>, room: number) {
  const shares = new Map<string, number>();
  let remaining = Math.max(0, room);
  const byHeight = lists.toSorted((a, b) => a.bodyHeight - b.bodyHeight);
  for (const [index, list] of byHeight.entries()) {
    const share = Math.min(list.bodyHeight, Math.floor(remaining / (byHeight.length - index)));
    shares.set(list.id, share);
    remaining -= share;
  }
  return shares;
}

export function budgetComposerStack(
  panels: ReadonlyArray<ComposerStackPanel>,
  cap: number,
  minListHeight = MIN_SCROLLING_LIST_HEIGHT,
): ComposerStackBudget {
  const fixedHeight = panels.reduce(
    (total, panel) =>
      total + panel.chromeHeight + (panel.kind === "blocking" ? panel.bodyHeight : 0),
    0,
  );
  const folded = new Set<string>();
  for (;;) {
    const open = panels.filter(
      (panel) => panel.kind === "list" && panel.bodyHeight > 0 && !folded.has(panel.id),
    );
    const total = open.reduce((sum, panel) => sum + panel.bodyHeight, fixedHeight);
    if (total <= cap) {
      return { folded: folded.size === 0 ? NO_FOLDS : folded, bodyMax: NO_LIMITS };
    }
    const shares = shareRoom(open, cap - fixedHeight);
    const readable = open.every(
      (panel) => (shares.get(panel.id) ?? 0) >= Math.min(minListHeight, panel.bodyHeight),
    );
    const leastImportant = open
      .filter((panel) => !panel.pinned)
      .toSorted((a, b) => a.rank - b.rank)[0];
    if (readable || !leastImportant) {
      return { folded: folded.size === 0 ? NO_FOLDS : folded, bodyMax: shares };
    }
    folded.add(leastImportant.id);
  }
}

export interface FoldableNotice {
  readonly id: string;
  /** False for notices that must stay in view on their own, such as errors. */
  readonly foldable: boolean;
}

/**
 * Which notices fold into the "+N more" bar. `notices` is ordered most
 * important first. From three foldable notices on, the most important stays
 * and the rest fold, unless the user expanded the bar.
 */
export function foldNotices(
  notices: ReadonlyArray<FoldableNotice>,
  expanded: boolean,
): { readonly hidden: ReadonlySet<string>; readonly overflow: number } {
  const foldable = notices.filter((notice) => notice.foldable);
  if (foldable.length < NOTICE_FOLD_THRESHOLD) return { hidden: NO_FOLDS, overflow: 0 };
  const rest = foldable.slice(1);
  return {
    hidden: expanded ? NO_FOLDS : new Set(rest.map((notice) => notice.id)),
    overflow: rest.length,
  };
}

/**
 * Trays whose list can fold to their header, in folding order: the stack folds
 * background work first and the user's own queue last. Questions and approvals
 * wait on the user, so they are not here: they never fold.
 */
export const COMPOSER_TRAY_FOLD_RANK = {
  "background-work": 1,
  tasks: 2,
  queue: 3,
} as const;

export type ComposerTrayId = keyof typeof COMPOSER_TRAY_FOLD_RANK;

export interface ComposerStackNotice {
  readonly priority?: "urgent" | "activity" | "notice" | undefined;
  readonly variant: string;
}

/**
 * How far above the composer a notice sits within its stack: 0 is the front
 * bar, nearest the composer. Running activity leads, then severity.
 */
export function composerNoticeDistance(notice: ComposerStackNotice): number {
  if (notice.priority === "activity") return 0;
  if (notice.priority === "urgent" || notice.variant === "error" || notice.variant === "warning") {
    return 1;
  }
  return 2;
}

/**
 * Splits notices that wait on the user's decision (approvals, limit recovery)
 * from the rest. Urgent ones get their own stack below the queue and tasks,
 * nearest the composer; the rest stack above the queue.
 */
export function partitionUrgentNotices<T extends ComposerStackNotice>(
  notices: ReadonlyArray<T>,
): { readonly urgent: ReadonlyArray<T>; readonly rest: ReadonlyArray<T> } {
  const urgent: T[] = [];
  const rest: T[] = [];
  for (const notice of notices) (notice.priority === "urgent" ? urgent : rest).push(notice);
  return { urgent, rest };
}

export function sameFolds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

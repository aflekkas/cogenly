import { create } from "zustand";

/**
 * Read state for the open thread.
 *
 * Viewing a thread marks it read once its latest run has completed and the
 * window is visible and focused. Marking the open thread unread puts a hold on
 * that: it stays unread while you stay on it, until you come back to it from
 * another thread, scroll the transcript to its end, or a newer run completes
 * (for example after you send).
 */
export interface ThreadUnreadHold {
  /** The latest run's completion the user marked unread. */
  readonly completedAt: string | null;
}

export const useThreadUnreadHolds = create<{
  holds: Readonly<Record<string, ThreadUnreadHold>>;
}>(() => ({ holds: {} }));

export function holdThreadUnread(threadKey: string, completedAt: string | null | undefined) {
  useThreadUnreadHolds.setState((state) => ({
    holds: { ...state.holds, [threadKey]: { completedAt: completedAt ?? null } },
  }));
}

export function releaseThreadUnreadHold(threadKey: string) {
  if (!(threadKey in useThreadUnreadHolds.getState().holds)) return;
  useThreadUnreadHolds.setState((state) => {
    const { [threadKey]: _released, ...holds } = state.holds;
    return { holds };
  });
}

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Whether a completed run is newer than the last visit (no visit counts as unseen). */
export function isCompletionUnseen(
  latestCompletedAt: string | null | undefined,
  lastVisitedAt: string | null | undefined,
): boolean {
  const completedMs = parseMs(latestCompletedAt);
  if (completedMs === null) return false;
  const visitedMs = parseMs(lastVisitedAt);
  return visitedMs === null || completedMs > visitedMs;
}

export interface AutoMarkReadInput {
  readonly latestCompletedAt: string | null | undefined;
  readonly lastVisitedAt: string | null | undefined;
  /** Window visible and focused, with this thread on screen. */
  readonly isViewing: boolean;
  readonly hold: ThreadUnreadHold | null | undefined;
}

/** Whether the open thread should record a visit now. */
export function shouldAutoMarkThreadRead(input: AutoMarkReadInput): boolean {
  if (!input.isViewing) return false;
  if (!isCompletionUnseen(input.latestCompletedAt, input.lastVisitedAt)) return false;
  // A hold only covers the run the user marked unread; a newer completion is news.
  if (input.hold && input.hold.completedAt === (input.latestCompletedAt ?? null)) return false;
  return true;
}

/**
 * One key per distinct read state, so a visit is dispatched once per state and
 * a later rewind (mark unread) yields a new key rather than being deduped.
 */
export function autoMarkReadKey(
  threadKey: string,
  latestCompletedAt: string | null | undefined,
  lastVisitedAt: string | null | undefined,
): string {
  return `${threadKey}|${latestCompletedAt ?? ""}|${lastVisitedAt ?? ""}`;
}

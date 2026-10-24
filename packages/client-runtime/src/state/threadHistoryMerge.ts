import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
} from "@cogenly/contracts";
import { isOrchestrationV2TurnItemVisible } from "@cogenly/shared/orchestrationV2Timeline";

export type ThreadHistoryMeta = {
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  /** True after at least one older page was merged; skip monolithic cache growth. */
  readonly expanded: boolean;
  /**
   * Max local turn ordinal known for partial progressive windows. Null when
   * unknown (legacy cache) or when history meta is cleared for a full snapshot.
   */
  readonly latestLocalTurnOrdinal: number | null;
};

export const EMPTY_THREAD_HISTORY_META: ThreadHistoryMeta = {
  historyCursor: null,
  hasMoreHistory: false,
  loading: false,
  error: null,
  expanded: false,
  latestLocalTurnOrdinal: null,
};

/** Whether a history-page response still matches the cursor that started it. */
export function isActiveHistoryRequestCursor(
  requestCursor: string,
  history: { readonly historyCursor: string | null },
): boolean {
  return history.historyCursor === requestCursor;
}

/**
 * Clear history loading after an interrupted load-earlier only when the
 * request cursor is still active. Does not touch stream/status/error.
 */
export function clearActiveHistoryLoading(
  requestCursor: string,
  history: ThreadHistoryMeta,
): ThreadHistoryMeta {
  if (!isActiveHistoryRequestCursor(requestCursor, history) || !history.loading) {
    return history;
  }
  return { ...history, loading: false };
}

function projectedItemKey(row: OrchestrationV2ProjectedTurnItem): string {
  return `${row.sourceThreadId}:${row.sourceItemId}`;
}

function renumberVisible(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2ProjectedTurnItem[] {
  return rows.map((row, position) => (row.position === position ? row : { ...row, position }));
}

/**
 * Merge an older history page into the live projection. Dedupes by
 * sourceThreadId + sourceItemId, keeps chronological order (older first), and
 * preserves newer live rows already present in state.
 */
export function mergeOlderHistoryIntoProjection(
  projection: OrchestrationV2ThreadProjection,
  olderItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2ThreadProjection {
  if (olderItems.length === 0) {
    return projection;
  }

  const currentByKey = new Map(
    projection.visibleTurnItems.map((row) => [projectedItemKey(row), row]),
  );
  const turnItemById = new Map(projection.turnItems.map((item) => [String(item.id), item]));
  const pageKeys = new Set<string>();
  const page: OrchestrationV2ProjectedTurnItem[] = [];
  for (const pageRow of olderItems) {
    const key = projectedItemKey(pageRow);
    if (pageKeys.has(key)) continue;
    let row = currentByKey.get(key) ?? pageRow;
    if (
      !currentByKey.has(key) &&
      (row.visibility === "local" || row.sourceThreadId === projection.thread.id)
    ) {
      const currentItem = turnItemById.get(String(row.sourceItemId));
      // Hidden live items stay hidden. Cold snapshots also retain interrupt
      // requests outside the visible window; paging may reveal those requests.
      if (currentItem !== undefined) {
        if (
          currentItem.type !== "run_interrupt_request" ||
          !isOrchestrationV2TurnItemVisible({
            item: currentItem,
            runs: projection.runs,
            attempts: projection.attempts,
            items: projection.turnItems,
          })
        )
          continue;
        row = { ...row, item: currentItem };
      }
    }
    pageKeys.add(key);
    page.push(row);
    if (
      (row.visibility === "local" || row.sourceThreadId === projection.thread.id) &&
      !turnItemById.has(String(row.sourceItemId))
    )
      turnItemById.set(String(row.sourceItemId), row.item);
  }
  if (page.length === 0) return projection;
  // Server page order fills gaps between rows from a partial conversation load.
  // Existing rows supply live values; rows outside this range keep their order.
  const visible = [
    ...page,
    ...projection.visibleTurnItems.filter((row) => !pageKeys.has(projectedItemKey(row))),
  ];
  if (
    visible.length === projection.visibleTurnItems.length &&
    visible.every((row, index) => row === projection.visibleTurnItems[index])
  )
    return projection;
  return {
    ...projection,
    turnItems: [...turnItemById.values()],
    visibleTurnItems: renumberVisible(visible),
  };
}

export function applyHistoryPageMeta(
  current: ThreadHistoryMeta,
  page: {
    readonly nextCursor: string | null;
    readonly hasMoreHistory: boolean;
  },
): ThreadHistoryMeta {
  return {
    historyCursor: page.nextCursor,
    hasMoreHistory: page.hasMoreHistory,
    loading: false,
    error: null,
    expanded: true,
    // Preserve the partial-timeline watermark across load-earlier pages.
    latestLocalTurnOrdinal: current.latestLocalTurnOrdinal,
  };
}

/**
 * Timeline rows a thread may hold before an idle client at the live end trims
 * back to the server's recent window. Live growth and load-earlier pages
 * otherwise accumulate for as long as the thread stays open.
 */
export const THREAD_HISTORY_TRIM_ROW_THRESHOLD = 400;
/** Rows a thread must grow by before a trim that changed nothing is retried. */
const THREAD_HISTORY_TRIM_RETRY_GROWTH = 100;

export function shouldRequestThreadHistoryTrim(input: {
  readonly rowCount: number;
  /** Row count at the previous trim request for this thread, if any. */
  readonly lastRequestRowCount: number | null;
  readonly atEnd: boolean;
  readonly busy: boolean;
}): boolean {
  if (!input.atEnd || input.busy || input.rowCount <= THREAD_HISTORY_TRIM_ROW_THRESHOLD) {
    return false;
  }
  return (
    input.lastRequestRowCount === null ||
    input.rowCount >= input.lastRequestRowCount + THREAD_HISTORY_TRIM_RETRY_GROWTH
  );
}

/**
 * Whether a fresh recent-window snapshot may replace the in-memory timeline.
 * An older snapshot would drop events already applied, and one that sheds few
 * rows is not worth re-rendering the whole timeline for.
 */
export function shouldInstallTrimmedThreadWindow(input: {
  readonly appliedSequence: number;
  readonly snapshotSequence: number;
  readonly currentRowCount: number;
  readonly nextRowCount: number;
}): boolean {
  return (
    input.snapshotSequence >= input.appliedSequence &&
    input.nextRowCount <= input.currentRowCount * 0.75
  );
}

/** Whether a client timeline should render its load-earlier control. */
export function shouldShowLoadEarlierControl(history: ThreadHistoryMeta): boolean {
  return history.hasMoreHistory || history.error !== null;
}

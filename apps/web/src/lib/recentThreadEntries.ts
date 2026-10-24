/**
 * How many threads the per-thread panel stores remember. Past it, the thread
 * written longest ago falls back to its defaults.
 */
export const RECENT_THREAD_ENTRY_LIMIT = 200;

/**
 * Writes a thread's entry as the most recent one, dropping the oldest past
 * `limit`. A record's insertion order is its recency, so it persists as is.
 * Scoped thread keys (`environmentId:threadId`) are never integer-like, so
 * object key order holds.
 */
export function setRecentThreadEntry<T>(
  record: Record<string, T>,
  key: string,
  value: T,
  limit = RECENT_THREAD_ENTRY_LIMIT,
): Record<string, T> {
  const entries = Object.entries(record).filter(([entryKey]) => entryKey !== key);
  entries.push([key, value]);
  return Object.fromEntries(entries.slice(-limit));
}

/** The record without a thread's entry, or the same record when it has none. */
export function withoutThreadEntry<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

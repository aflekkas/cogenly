/**
 * What the project panel says about a folder at a glance: "1 repo · 4 chats ·
 * 2 files", leaving out what the folder has none of; null when it is empty.
 * Work is counted with chats on purpose: the one-liner names what the user
 * files, and the sections below split it.
 */
export function projectPanelSummary(counts: {
  readonly repositories: number;
  readonly chats: number;
  readonly work: number;
  readonly files: number;
}): string | null {
  const threads = counts.chats + counts.work;
  const parts = [
    plural(counts.repositories, "repo", "repos"),
    plural(threads, "chat", "chats"),
    plural(counts.files, "file", "files"),
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function plural(count: number, one: string, many: string): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The newest activity across a folder's chats and Work, as the ISO time of
 * the most recent one, or null when the folder holds nothing. Each list is
 * scanned whole, so it does not rely on either being sorted.
 */
export function latestProjectActivity<T>(
  contents: { readonly chats: ReadonlyArray<T>; readonly work: ReadonlyArray<T> } | undefined,
  activityAt: (thread: T) => string,
): string | null {
  if (!contents) return null;
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const thread of [...contents.chats, ...contents.work]) {
    const at = activityAt(thread);
    const ms = Date.parse(at);
    if (Number.isNaN(ms) || ms <= latestMs) continue;
    latestMs = ms;
    latest = at;
  }
  return latest;
}

/** Threads newest first by their activity time; a stable sort, so ties keep input order. */
export function sortRecentFirst<T>(
  threads: ReadonlyArray<T>,
  activityAt: (thread: T) => string,
): T[] {
  return threads
    .map((thread, index) => ({ thread, index, ms: Date.parse(activityAt(thread)) || 0 }))
    .sort((left, right) => right.ms - left.ms || left.index - right.index)
    .map((entry) => entry.thread);
}

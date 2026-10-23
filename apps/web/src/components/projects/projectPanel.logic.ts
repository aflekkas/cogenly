/**
 * What a project says about itself at a glance: "1 repo · 1 chat · 3 Work ·
 * 1 agent", leaving out what it has none of; null when it is empty. Work is a
 * mass noun, so it reads the same at any count.
 */
export function projectPanelSummary(counts: {
  readonly repositories: number;
  readonly chats: number;
  readonly work: number;
  readonly files: number;
  readonly agents?: number;
}): string | null {
  const parts = [
    plural(counts.repositories, "repo", "repos"),
    plural(counts.chats, "chat", "chats"),
    plural(counts.work, "Work", "Work"),
    plural(counts.agents ?? 0, "agent", "agents"),
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

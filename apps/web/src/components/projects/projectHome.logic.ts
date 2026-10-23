/**
 * View state for the project home: the chat-first page with persistent cards
 * on the right. Everything here is pure so the cards stay dumb.
 */

/** How long a just-added card row glows before it settles. Matches `.project-card-row-arrived`. */
export const PROJECT_CARD_ARRIVAL_MS = 1200;

/** How many rows the Recent card shows before it points at the sidebar. */
export const PROJECT_RECENT_LIMIT = 5;

/** The status pip at the end of a Recent row; null shows none. */
export type ProjectRecentPip = "running" | "needs-you" | "failed" | "done" | null;

/** The sidebar's status words, so the pips match its colours. */
export type ProjectThreadStatus =
  | "approval"
  | "input"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

/**
 * Running and blocked threads read the same as the sidebar; a Work item whose
 * last run completed reads as done. A settled chat needs no pip.
 */
export function projectRecentPip(input: {
  readonly kind: "chat" | "work";
  readonly status: ProjectThreadStatus;
  readonly latestRunCompleted: boolean;
}): ProjectRecentPip {
  switch (input.status) {
    case "approval":
    case "input":
      return "needs-you";
    case "working":
    case "waiting":
      return "running";
    case "failed":
    case "limited":
      return "failed";
    case "ready":
      return input.kind === "work" && input.latestRunCompleted ? "done" : null;
  }
}

export interface ProjectRecentItem<T> {
  readonly kind: "chat" | "work";
  readonly key: string;
  readonly thread: T;
  readonly activityMs: number;
}

/**
 * Chats and Work in one newest-first list, capped at `limit`, with how many
 * were left out. Ties keep chats before Work and input order within each, so
 * the list never reshuffles between renders. `exclude` drops threads the page
 * shows elsewhere (the project chat itself).
 */
export function mixProjectRecent<T>(input: {
  readonly chats: ReadonlyArray<T>;
  readonly work: ReadonlyArray<T>;
  readonly keyOf: (thread: T) => string;
  readonly activityAt: (thread: T) => string;
  readonly limit?: number;
  readonly exclude?: ReadonlySet<string>;
}): { readonly items: ReadonlyArray<ProjectRecentItem<T>>; readonly hidden: number } {
  const limit = input.limit ?? PROJECT_RECENT_LIMIT;
  const tagged = [
    ...input.chats.map((thread) => ({ kind: "chat" as const, thread })),
    ...input.work.map((thread) => ({ kind: "work" as const, thread })),
  ]
    .map((entry, index) => ({
      ...entry,
      index,
      key: input.keyOf(entry.thread),
      activityMs: Date.parse(input.activityAt(entry.thread)) || 0,
    }))
    .filter((entry) => !input.exclude?.has(entry.key))
    .sort((left, right) => right.activityMs - left.activityMs || left.index - right.index);
  return {
    items: tagged
      .slice(0, limit)
      .map(({ kind, key, thread, activityMs }) => ({ kind, key, thread, activityMs })),
    hidden: Math.max(0, tagged.length - limit),
  };
}

/**
 * The count beside a card's label: hidden at zero so an empty card reads
 * through its copy, not a "0".
 */
export function projectCardCount(count: number): number | null {
  return count > 0 ? count : null;
}

/**
 * The keys that arrived since the last snapshot. The first snapshot (null)
 * is history on load, so nothing in it counts as new: only live changes glow.
 */
export function arrivedKeys(
  previous: ReadonlySet<string> | null,
  next: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (previous === null) return [];
  return next.filter((key) => !previous.has(key));
}

/** What the Instructions card says about its draft. */
export type InstructionsSaveState = "saved" | "unsaved" | "saving" | "failed";

export function instructionsSaveState(input: {
  readonly draft: string;
  readonly saved: string;
  readonly saving: boolean;
  readonly failed: boolean;
}): InstructionsSaveState {
  if (input.saving) return "saving";
  if (normalizeInstructions(input.draft) === normalizeInstructions(input.saved)) return "saved";
  return input.failed ? "failed" : "unsaved";
}

/** Trailing whitespace is not a change worth saving. */
export function normalizeInstructions(text: string): string {
  return text.replace(/\s+$/u, "");
}

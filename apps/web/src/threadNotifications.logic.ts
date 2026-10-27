/** Clock skew between server and client should not swallow a real completion. */
export const HISTORY_GRACE_MS = 60_000;
/** A reply this quick to the thread you are looking at needs no sound. */
export const QUICK_REPLY_MS = 2_000;
/** Threads finishing within this window of each other share one sound. */
export const SOUND_COALESCE_MS = 1_000;

export interface ThreadNotificationMark {
  /** `<runId>:<status>` while the thread waits on the user or failed, else null. */
  readonly attention: string | null;
  /** When the latest completed turn ended, kept across later states. */
  readonly completion: number | null;
}

/**
 * What a thread's change is worth telling the user, compared with what this
 * client saw last. A thread seen for the first time (a history load, or the
 * first snapshot after a reconnect) is never news, nor is an archived thread
 * or a run that ended before the client started watching. Each run's ask and
 * each completed turn notify once.
 */
export function threadNotificationKind(input: {
  readonly prior: ThreadNotificationMark | undefined;
  readonly next: ThreadNotificationMark;
  readonly archived: boolean;
  /** The latest run's end, NaN while it has none. */
  readonly completedAt: number;
  /** When this client started watching the environment. */
  readonly watchingSince: number;
}): "completion" | "input" | null {
  const { prior, next } = input;
  if (!prior || input.archived) return null;
  if (input.completedAt < input.watchingSince - HISTORY_GRACE_MS) return null;
  if (next.attention && next.attention !== prior.attention) return "input";
  if (next.completion !== null && (prior.completion === null || next.completion > prior.completion))
    return "completion";
  return null;
}

/**
 * A finished turn sounds unless it answered, in under two seconds, the thread
 * the user is looking at: they are watching it arrive.
 */
export function completionWantsSound(input: {
  readonly viewing: boolean;
  /** When the turn was sent, or started when that is unknown. */
  readonly sentAt: string | null;
  readonly completedAt: number;
}): boolean {
  if (!input.viewing || input.sentAt === null) return true;
  const sentAt = Date.parse(input.sentAt);
  return !Number.isFinite(sentAt) || input.completedAt - sentAt >= QUICK_REPLY_MS;
}

/** One sound for a burst: returns false for a call within `windowMs` of the last sounded one. */
export function createSoundCoalescer(windowMs = SOUND_COALESCE_MS) {
  let last = Number.NEGATIVE_INFINITY;
  return (now: number) => {
    if (now - last < windowMs) return false;
    last = now;
    return true;
  };
}

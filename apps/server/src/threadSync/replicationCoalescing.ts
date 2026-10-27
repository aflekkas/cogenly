/**
 * Replication sends a thread's events as a subsequence: an update event that a
 * later one for the same entity fully replaces is skipped, so a peer receives
 * the latest state of streaming entities instead of every intermediate one.
 *
 * Only types whose projection upserts the whole payload by `payload.id`
 * coalesce. Some keep a field a later snapshot omits (see ProjectionStore's
 * `upsertProviderTurn`, `preserveRunRecordedFields` and
 * `preserveCompletionDelivery`), so an update that still supplies such a
 * field is kept. Each entity's first event is kept too: projection rows and
 * turn-item positions are allocated on first sight, so first sights must
 * arrive in the owner's order. An entity with an event at or before the
 * peer's cursor was already seen there. Applying the subsequence therefore
 * ends in the same projections as applying every event.
 */

/** Coalesced event types, with the payload fields their projection keeps from earlier events. */
export const COALESCED_EVENT_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "turn-item.updated": [],
  "node.updated": [],
  "message.updated": [],
  "provider-turn.updated": ["tokenUsage"],
  "run.updated": ["delegatedCompletion", "restartCancelledBackgroundWork"],
  "subagent.updated": ["completionDelivery"],
};

export const COALESCED_EVENT_TYPES = Object.keys(COALESCED_EVENT_FIELDS);
export const PRESERVED_EVENT_FIELDS = [...new Set(Object.values(COALESCED_EVENT_FIELDS).flat())];

export interface ReplicationEventSummary {
  readonly sequence: number;
  readonly threadId: string;
  readonly type: string;
  /** `payload.id`; null for types that do not coalesce. */
  readonly entityId: string | null;
  /** JSON type of each preserved field the payload carries, by field name. */
  readonly fieldTypes: Readonly<Record<string, string>>;
  /** Kept as sent by a newer build, whose fields this one cannot judge. */
  readonly retained: boolean;
}

export const replicationEntityKey = (threadId: string, type: string, entityId: string) =>
  JSON.stringify([threadId, type, entityId]);

/**
 * Sequences of `events` (in sequence order) that a later event in the same
 * list supersedes. The caller skips them and may move its cursor past them:
 * the superseding event is sent, or is still ahead of the cursor.
 *
 * `seen` holds keys (replicationEntityKey) of entities the peer already has
 * an event for, so their first event here is not a first sight.
 */
export const supersededReplicationEvents = (
  events: ReadonlyArray<ReplicationEventSummary>,
  seen: ReadonlySet<string> = new Set(),
): ReadonlySet<number> => {
  const chains = new Map<string, Array<ReplicationEventSummary>>();
  for (const event of events) {
    if (event.entityId === null || COALESCED_EVENT_FIELDS[event.type] === undefined) continue;
    const key = replicationEntityKey(event.threadId, event.type, event.entityId);
    const chain = chains.get(key);
    if (chain === undefined) chains.set(key, [event]);
    else chain.push(event);
  }
  const superseded = new Set<number>();
  for (const [key, chain] of chains) {
    const first = seen.has(key) ? 0 : 1;
    if (chain.length < first + 2) continue;
    const fields = COALESCED_EVENT_FIELDS[chain[0]!.type]!;
    // Fields a later kept event sets, so an earlier value no longer shows.
    const covered = new Set<string>();
    const cover = (event: ReplicationEventSummary) => {
      for (const field of fields) {
        const type = event.fieldTypes[field];
        if (type !== undefined && type !== "null") covered.add(field);
      }
    };
    cover(chain.at(-1)!);
    // The last, and a first sight, always travel; walk the rest from the end.
    for (let at = chain.length - 2; at >= first; at--) {
      const event = chain[at]!;
      const needed = fields.some(
        (field) => event.fieldTypes[field] !== undefined && !covered.has(field),
      );
      if (event.retained || needed) cover(event);
      else superseded.add(event.sequence);
    }
  }
  return superseded;
};

import type { OrchestrationV2ThreadShell, ThreadId } from "@cogenly/contracts";

/** How a thread relates to the thread it came from. */
export type ThreadOriginKind = "subagent" | "fork" | "chat" | "agent-conversation";

export interface ThreadOrigin {
  readonly kind: ThreadOriginKind;
  readonly threadId: ThreadId;
}

type LineageSource = Pick<
  OrchestrationV2ThreadShell,
  "id" | "lineage" | "forkedFrom" | "sourceThreadId" | "workOrigin"
>;

/** Shared with the details card's Lineage rows, so both name the link the same way. */
export const THREAD_ORIGIN_LABELS: Record<ThreadOriginKind, string> = {
  subagent: "Parent agent",
  fork: "Forked from",
  chat: "From chat",
  "agent-conversation": "From agent conversation",
};

/**
 * The one thread this thread goes back to. A structural parent (the agent that
 * spawned it, or the thread it was forked from) wins over a Work handoff's
 * source chat: a subagent of a Work session inherits that session's source
 * chat, but its way back is the session.
 */
export function resolveThreadOrigin(source: LineageSource): ThreadOrigin | null {
  const parentThreadId =
    source.forkedFrom?.type === "run" ? source.forkedFrom.threadId : source.lineage.parentThreadId;
  if (parentThreadId !== null && parentThreadId !== source.id) {
    return {
      kind: source.lineage.relationshipToParent === "subagent" ? "subagent" : "fork",
      threadId: parentThreadId,
    };
  }
  const sourceThreadId = source.sourceThreadId ?? null;
  if (sourceThreadId !== null && sourceThreadId !== source.id) {
    return {
      kind: source.workOrigin === "agent" ? "agent-conversation" : "chat",
      threadId: sourceThreadId,
    };
  }
  return null;
}

export interface ThreadLineageAncestor {
  readonly threadId: ThreadId;
  /** Null while the ancestor's shell is unknown (not loaded yet, or deleted). */
  readonly title: string | null;
  /** How the thread below this one in the chain came from it. */
  readonly kind: ThreadOriginKind;
}

/** Deep enough for subagents of a Work session started from a chat, and their subagents. */
export const THREAD_LINEAGE_MAX_DEPTH = 4;

/**
 * Ancestors of a thread, root first, its direct origin last. Walks origins
 * through `lookup` until a thread has none, an ancestor is unknown (kept, with
 * no title, and the walk stops), a cycle closes, or `maxDepth` is reached.
 */
export function buildThreadLineageChain(
  current: LineageSource,
  lookup: (threadId: ThreadId) => { readonly title: string; readonly source: LineageSource } | null,
  maxDepth = THREAD_LINEAGE_MAX_DEPTH,
): ReadonlyArray<ThreadLineageAncestor> {
  const ancestors: Array<ThreadLineageAncestor> = [];
  const visited = new Set<string>([current.id]);
  let origin = resolveThreadOrigin(current);
  while (origin !== null && ancestors.length < maxDepth && !visited.has(origin.threadId)) {
    visited.add(origin.threadId);
    const thread = lookup(origin.threadId);
    ancestors.push({
      threadId: origin.threadId,
      title: thread?.title.trim() || null,
      kind: origin.kind,
    });
    origin = thread === null ? null : resolveThreadOrigin(thread.source);
  }
  return ancestors.toReversed();
}

export interface ThreadBreadcrumbSegments {
  /** Shown before the collapsed middle; null when the chain is a single parent. */
  readonly root: ThreadLineageAncestor | null;
  /** Folded into the "…" menu. */
  readonly hidden: ReadonlyArray<ThreadLineageAncestor>;
  /** The direct origin, the segment the back chevron belongs to. */
  readonly parent: ThreadLineageAncestor;
}

/** Root, a collapsed middle, and the direct parent; null for a thread with no origin. */
export function collapseThreadBreadcrumb(
  ancestors: ReadonlyArray<ThreadLineageAncestor>,
): ThreadBreadcrumbSegments | null {
  const parent = ancestors.at(-1);
  if (parent === undefined) return null;
  if (ancestors.length === 1) return { root: null, hidden: [], parent };
  return { root: ancestors[0] ?? null, hidden: ancestors.slice(1, -1), parent };
}

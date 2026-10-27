import { ACTION_LATENCY_BUDGETS, type LatencyAction } from "@cogenly/contracts";
import type * as Tracer from "effect/Tracer";

import { recordCompletedSpan } from "./clientTracer";

type PendingAction = {
  action: LatencyAction;
  key: string;
  startedAt: number;
  links: Array<Tracer.SpanLink>;
};
const pending = new Map<string, PendingAction>();
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};
const actionKey = (action: LatencyAction, key: string) => `${action}:${key}`;
const epochNano = (at: number) => BigInt(Math.round((performance.timeOrigin + at) * 1_000_000));

export const actionTimestamp = () => performance.now();

/** Called at the shared entry point, before uploads, navigation or RPC work starts. */
export function beginAction(action: LatencyAction, key = "", startedAt = performance.now()): void {
  const id = actionKey(action, key);
  if (pending.has(id)) finishAction(action, key, "superseded");
  if (pending.size >= 128) {
    const oldest = pending.values().next().value;
    if (oldest) finishAction(oldest.action, oldest.key, "superseded");
  }
  pending.set(id, { action, key, startedAt, links: [] });
  changed();
}

export function beginActionIfAbsent(action: LatencyAction, key: string): void {
  if (!pending.has(actionKey(action, key))) beginAction(action, key);
}

export function subscribePendingActions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function hasPendingStop(): boolean {
  return [...pending.values()].some((entry) => entry.action === "turn.stop");
}

/** Links the visible result to the RPC trace, whose children contain server work. */
export function linkAction(action: LatencyAction, key: string, span: Tracer.AnySpan): void {
  const entry = pending.get(actionKey(action, key));
  if (entry && entry.links.length < 8) entry.links.push({ span, attributes: {} });
}

export function recordActionDuration(
  action: LatencyAction,
  startedAt: number,
  phase: "visible" | "ack" = "visible",
  outcome = "success",
  links: Array<Tracer.SpanLink> = [],
): void {
  const endedAt = performance.now();
  recordCompletedSpan({
    name: `ui.action.${action}`,
    startTime: epochNano(startedAt),
    endTime: epochNano(endedAt),
    links,
    attributes: {
      "action.name": action,
      "action.phase": phase,
      "action.outcome": outcome,
      "action.budget_ms": ACTION_LATENCY_BUDGETS[action],
      "action.breach": endedAt - startedAt > ACTION_LATENCY_BUDGETS[action],
    },
  });
}

export function finishAction(action: LatencyAction, key = "", outcome = "success"): void {
  const id = actionKey(action, key);
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  changed();
  recordActionDuration(action, entry.startedAt, "visible", outcome, entry.links);
}

export function finishStoppedThreadActionsAfterPaint(
  threads: ReadonlyArray<{
    readonly id: string;
    readonly environmentId: string;
    readonly activeRunId: string | null;
    readonly status: string;
    readonly pendingBackgroundTasks?: ReadonlyArray<unknown> | undefined;
    readonly pendingRuntimeRequest: unknown;
  }>,
): void {
  for (const entry of pending.values()) {
    if (entry.action !== "turn.stop") continue;
    const thread = threads.find((thread) => `${thread.environmentId}:${thread.id}` === entry.key);
    if (
      thread &&
      thread.activeRunId === null &&
      ["idle", "completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
        thread.status,
      ) &&
      thread.pendingRuntimeRequest === null &&
      (thread.pendingBackgroundTasks?.length ?? 0) === 0
    )
      finishActionAfterPaint(entry.action, entry.key);
  }
}

/** A task after the frame runs once React's commit has had an opportunity to paint. */
export function finishActionAfterPaint(action: LatencyAction, key = ""): void {
  const entry = pending.get(actionKey(action, key));
  if (!entry) return;
  // Shared state helpers also run in nonvisual tests; there is no paint to time there.
  if (typeof requestAnimationFrame !== "function") {
    pending.delete(actionKey(action, key));
    changed();
    return;
  }
  requestAnimationFrame(() =>
    setTimeout(() => {
      if (pending.get(actionKey(action, key)) === entry) finishAction(action, key);
    }, 0),
  );
}

/** Checks only pending sends, so streaming tokens never walk the full message history. */
export function finishMessageActionsAfterPaint(
  environmentId: string,
  messages: ReadonlyArray<{ readonly id: string }>,
): void {
  for (const entry of pending.values()) {
    if (
      (entry.action === "message.send" || entry.action === "message.queue") &&
      entry.key.startsWith(`${environmentId}:`)
    ) {
      const id = entry.key.slice(environmentId.length + 1);
      if (messages.some((message) => message.id === id))
        finishActionAfterPaint(entry.action, entry.key);
    }
  }
}

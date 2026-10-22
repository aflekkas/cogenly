/**
 * Pure mapping from stored T3 Code thread events to Cogenly domain events.
 *
 * T3 and Cogenly share the V2 event vocabulary, so most events decode with
 * Cogenly's own schema unchanged. The mapping only rewrites what must differ in
 * this environment: project ids (matched by folder), the event id (prefixed so
 * a re-run recognizes what it already wrote), and live runtime state. A T3 run
 * that was running, a session that was ready or a request that was pending
 * would otherwise look like work Cogenly must recover or continue, so every
 * such state is recorded as stopped as it is replayed. Later events in the
 * same history still move an entity to its real final state.
 */
import {
  EventId,
  OrchestrationV2DomainEventJson,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type ProjectId,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import type { T3SourceEventRow } from "./T3SourceDatabase.ts";

export const T3_IMPORT_EVENT_ID_PREFIX = "t3-import:v1:";

export const importedEventId = (sourceEventId: string) =>
  EventId.make(`${T3_IMPORT_EVENT_ID_PREFIX}${sourceEventId}`);

export interface T3EventMappingContext {
  /** T3 project id to the Cogenly project the thread lands in. */
  readonly projectIds: ReadonlyMap<string, ProjectId>;
  /**
   * Each imported thread's target project, for events that still name a T3
   * project the thread later moved out of.
   */
  readonly threadProjectIds: ReadonlyMap<string, ProjectId>;
  /** T3 thread ids that collide with an unrelated Cogenly thread, to their replacement ids. */
  readonly threadIdRemap: ReadonlyMap<string, string>;
}

export type T3EventMapping =
  | {
      readonly _tag: "Mapped";
      readonly event: OrchestrationV2DomainEvent;
      /** The event carried live runtime state that was recorded as stopped. */
      readonly normalized: boolean;
    }
  | { readonly _tag: "Skipped"; readonly reason: string };

const decodeEventJson = Schema.decodeUnknownExit(OrchestrationV2DomainEventJson);

const QUOTED = /"(?:[^"\\]|\\.)*"/g;

/**
 * A decode failure without any payload values: schema messages quote the
 * offending value, which may be message text.
 */
export function redactedDecodeReason(eventType: string, cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const firstLine = raw.split("\n").find((line) => line.trim().length > 0) ?? "";
  const redacted = firstLine.replace(QUOTED, '"…"').replace(/\s+/g, " ").trim().slice(0, 160);
  return `Does not decode as ${eventType}${redacted.length > 0 ? `: ${redacted}` : ""}`;
}

function replaceAllIds(text: string, remap: ReadonlyMap<string, string>): string {
  let result = text;
  for (const [from, to] of remap) {
    if (result.includes(from)) result = result.split(from).join(to);
  }
  return result;
}

function parseObject(json: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const ACTIVE_RUN = new Set(["preparing", "starting", "running", "waiting"]);
const ACTIVE_WORK = new Set(["pending", "running", "waiting"]);
const LIVE_SESSION = new Set(["starting", "ready", "running", "waiting"]);

function normalizeTurnItem(
  item: OrchestrationV2TurnItem,
  at: OrchestrationV2DomainEvent["occurredAt"],
): OrchestrationV2TurnItem | undefined {
  let next: OrchestrationV2TurnItem | undefined;
  if (ACTIVE_WORK.has(item.status)) {
    next = { ...item, status: "interrupted", completedAt: item.completedAt ?? at };
  }
  if (item.type === "secret_request" && item.secretStatus === "pending") {
    next = { ...(next ?? item), secretStatus: "cancelled" } as OrchestrationV2TurnItem;
  }
  if (
    (item.type === "assistant_message" ||
      item.type === "reasoning" ||
      item.type === "proposed_plan") &&
    "streaming" in item &&
    item.streaming === true
  ) {
    next = { ...(next ?? item), streaming: false } as OrchestrationV2TurnItem;
  }
  return next;
}

/**
 * Record live runtime state as stopped. Returns undefined when the event
 * carries nothing live.
 */
export function normalizeRuntimeState(
  event: OrchestrationV2DomainEvent,
): OrchestrationV2DomainEvent | undefined {
  const at = event.occurredAt;
  switch (event.type) {
    case "run.created":
    case "run.updated": {
      const run = event.payload;
      const queued = run.status === "queued";
      const active = ACTIVE_RUN.has(run.status);
      const delivery = run.delegatedCompletion?.delivery ?? null;
      if (!queued && !active && delivery === null) return undefined;
      return {
        ...event,
        payload: {
          ...run,
          ...(queued || active
            ? {
                status: queued ? ("cancelled" as const) : ("interrupted" as const),
                completedAt: run.completedAt ?? at,
              }
            : {}),
          ...(run.delegatedCompletion === undefined
            ? {}
            : { delegatedCompletion: { ...run.delegatedCompletion, delivery: null } }),
        },
      };
    }
    case "run-attempt.created":
    case "run-attempt.updated":
      return event.payload.status === "pending" || event.payload.status === "running"
        ? {
            ...event,
            payload: {
              ...event.payload,
              status: "interrupted",
              completedAt: event.payload.completedAt ?? at,
            },
          }
        : undefined;
    case "node.updated":
      return ACTIVE_WORK.has(event.payload.status)
        ? {
            ...event,
            payload: {
              ...event.payload,
              status: "interrupted",
              completedAt: event.payload.completedAt ?? at,
            },
          }
        : undefined;
    case "subagent.updated":
      return ACTIVE_WORK.has(event.payload.status)
        ? {
            ...event,
            payload: {
              ...event.payload,
              status: "interrupted",
              completedAt: event.payload.completedAt ?? at,
            },
          }
        : undefined;
    case "provider-session.attached":
    case "provider-session.updated":
      return LIVE_SESSION.has(event.payload.status)
        ? { ...event, payload: { ...event.payload, status: "stopped" } }
        : undefined;
    case "provider-thread.updated": {
      const thread = event.payload;
      const pending = thread.pendingBackgroundTasks?.length ?? 0;
      if (thread.status !== "active" && pending === 0) return undefined;
      return {
        ...event,
        payload: {
          ...thread,
          status: thread.status === "active" ? "idle" : thread.status,
          pendingBackgroundTasks: [],
        },
      };
    }
    case "provider-turn.updated":
      return event.payload.status === "pending" || event.payload.status === "running"
        ? {
            ...event,
            payload: {
              ...event.payload,
              status: "interrupted",
              completedAt: event.payload.completedAt ?? at,
            },
          }
        : undefined;
    case "runtime-request.updated":
      return event.payload.status === "pending"
        ? {
            ...event,
            payload: {
              ...event.payload,
              status: "cancelled",
              resolvedAt: event.payload.resolvedAt ?? at,
            },
          }
        : undefined;
    case "message.updated":
      return event.payload.streaming
        ? { ...event, payload: { ...event.payload, streaming: false } }
        : undefined;
    case "turn-item.updated": {
      const item = normalizeTurnItem(event.payload, at);
      return item === undefined ? undefined : { ...event, payload: item };
    }
    default:
      return undefined;
  }
}

function withoutWatch<Link extends { readonly watch?: unknown }>(link: Link): Link {
  if (link.watch === undefined) return link;
  const { watch: _watch, ...rest } = link;
  return rest as Link;
}

/** Decode one stored T3 event and rewrite it for this environment. */
export function mapT3Event(row: T3SourceEventRow, context: T3EventMappingContext): T3EventMapping {
  const remap = context.threadIdRemap;
  const payloadJson = remap.size === 0 ? row.payloadJson : replaceAllIds(row.payloadJson, remap);
  const payload = parseObject(payloadJson);
  if (payload === undefined) {
    return { _tag: "Skipped", reason: `Payload of ${row.eventType} is not a JSON object` };
  }
  const metadata = parseObject(row.metadataJson) ?? {};
  const threadId = remap.get(row.threadId) ?? row.threadId;
  const decoded = decodeEventJson({
    id: importedEventId(row.eventId),
    threadId,
    type: row.eventType,
    occurredAt: row.occurredAt,
    payload,
    ...(metadata.runId === undefined ? {} : { runId: metadata.runId }),
    ...(metadata.nodeId === undefined ? {} : { nodeId: metadata.nodeId }),
    ...(metadata.driver === undefined ? {} : { driver: metadata.driver }),
    ...(metadata.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: metadata.providerInstanceId }),
    ...(metadata.rawEventId === undefined ? {} : { rawEventId: metadata.rawEventId }),
  });
  if (Exit.isFailure(decoded)) {
    return {
      _tag: "Skipped",
      reason: redactedDecodeReason(row.eventType, Exit.isFailure(decoded) ? decoded.cause : ""),
    };
  }
  let event: OrchestrationV2DomainEvent = decoded.value;
  if (event.type.startsWith("thread.") && "projectId" in event.payload) {
    const thread = event.payload;
    const projectId =
      context.projectIds.get(thread.projectId) ?? context.threadProjectIds.get(row.threadId);
    if (projectId === undefined) {
      return { _tag: "Skipped", reason: "Thread belongs to a project outside the import scope" };
    }
    event = {
      ...event,
      payload: {
        ...thread,
        projectId,
        // Usage-limit auto-resume and in-flight title generation are T3 work.
        ...(thread.limitRecovery === undefined ? {} : { limitRecovery: null }),
        ...(thread.titleRegeneration === undefined ? {} : { titleRegeneration: null }),
        // A pull request watch polls the host and wakes the thread; the user re-enables it here.
        ...(thread.pullRequests === undefined
          ? {}
          : { pullRequests: thread.pullRequests.map(withoutWatch) }),
      },
    } as OrchestrationV2DomainEvent;
  }
  if (event.type === "thread.pull-request-link-updated" && event.payload.watch !== undefined) {
    event = { ...event, payload: withoutWatch(event.payload) };
  }
  const normalized = normalizeRuntimeState(event);
  return normalized === undefined
    ? { _tag: "Mapped", event, normalized: false }
    : { _tag: "Mapped", event: normalized, normalized: true };
}

/** Attachment ids a mapped event references, for copying their files. */
export function referencedAttachmentIds(event: OrchestrationV2DomainEvent): ReadonlyArray<string> {
  if (event.type === "message.updated") {
    return event.payload.attachments.map((attachment) => attachment.id);
  }
  if (event.type === "turn-item.updated" && event.payload.type === "user_message") {
    return event.payload.attachments.map((attachment) => attachment.id);
  }
  return [];
}

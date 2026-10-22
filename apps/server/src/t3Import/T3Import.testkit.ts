// @effect-diagnostics nodeBuiltinImport:off
/** Synthetic T3 Code databases for importer tests: T3's schema, made-up rows. */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  DEFAULT_RUNTIME_MODE,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  OrchestrationV2DomainEventJson,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

export const encodeEvent = Schema.encodeSync(OrchestrationV2DomainEventJson);
const at = DateTime.makeUnsafe("2026-10-01T10:00:00.000Z");
export const T3_PROJECT = "mcp:t3-project";
export const COGENLY_PROJECT = ProjectId.make("cogenly-project");

export function thread(
  id: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread {
  const threadId = ThreadId.make(id);
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make(T3_PROJECT),
    title: "Fixture thread",
    providerInstanceId: ProviderInstanceId.make("claude-personal"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("claude-personal"),
      model: "claude-opus",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

export function created(
  id: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2DomainEvent {
  return {
    id: `evt-${id}-created` as OrchestrationV2DomainEvent["id"],
    type: "thread.created",
    threadId: ThreadId.make(id),
    occurredAt: at,
    payload: thread(id, overrides),
  };
}

export function message(threadId: string, n: number): OrchestrationV2DomainEvent {
  return {
    id: `evt-${threadId}-msg-${n}` as OrchestrationV2DomainEvent["id"],
    type: "message.updated",
    threadId: ThreadId.make(threadId),
    occurredAt: at,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: MessageId.make(`${threadId}:msg:${n}`),
      threadId: ThreadId.make(threadId),
      runId: null,
      nodeId: null,
      role: "user",
      text: `synthetic ${n}`,
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  };
}

export function run(threadId: string, status: "running" | "completed"): OrchestrationV2DomainEvent {
  return {
    id: `evt-${threadId}-run-${status}` as OrchestrationV2DomainEvent["id"],
    type: status === "running" ? "run.created" : "run.updated",
    threadId: ThreadId.make(threadId),
    occurredAt: at,
    payload: {
      id: RunId.make(`run:${threadId}:1`),
      threadId: ThreadId.make(threadId),
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("claude-personal"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claude-personal"),
        model: "claude-opus",
      },
      providerThreadId: null,
      userMessageId: MessageId.make(`${threadId}:msg:1`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: at,
      startedAt: at,
      completedAt: status === "completed" ? at : null,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}

/** A T3 Code database with the tables the importer reads; schema only, synthetic rows. */
export function makeT3Fixture() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-import-fixture-"));
  const workspaceRoot = NodePath.join(dir, "project");
  NodeFS.mkdirSync(workspaceRoot);
  const dbPath = NodePath.join(dir, "statev2.sqlite");
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE orchestration_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
      aggregate_kind TEXT NOT NULL, stream_id TEXT NOT NULL, stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, command_id TEXT,
      causation_event_id TEXT, correlation_id TEXT, actor_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL, metadata_json TEXT NOT NULL,
      application_event_version INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX idx_orchestration_events_agent_stream_sequence ON orchestration_events(stream_id, sequence)
      WHERE application_event_version = 2 AND aggregate_kind = 'thread';
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL,
      workspace_root TEXT NOT NULL, scripts_json TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL, title TEXT NOT NULL, default_provider TEXT NOT NULL,
      runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL, active_provider_thread_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, deleted_at TEXT,
      payload_json TEXT NOT NULL, provider_instance_id TEXT);
    CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL, payload_json TEXT NOT NULL);
  `);
  db.prepare(`INSERT INTO projection_projects VALUES (?, 'fixture', ?, '[]', ?, ?, NULL)`).run(
    T3_PROJECT,
    workspaceRoot,
    at.toString(),
    at.toString(),
  );
  const versions = new Map<string, number>();
  const append = (event: OrchestrationV2DomainEvent, raw?: { payloadJson: string }) => {
    const encoded = encodeEvent(event);
    const version = versions.get(event.threadId) ?? 0;
    versions.set(event.threadId, version + 1);
    db.prepare(
      `INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type,
         occurred_at, command_id, actor_kind, payload_json, metadata_json, application_event_version)
       VALUES (?, 'thread', ?, ?, ?, ?, NULL, 'server', ?, '{}', 2)`,
    ).run(
      event.id,
      event.threadId,
      version,
      event.type,
      encoded.occurredAt,
      raw?.payloadJson ?? JSON.stringify(encoded.payload),
    );
    if (event.type === "thread.created") {
      db.prepare(
        `INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, 'Fixture', 'claudeAgent',
           'full-access', 'default', NULL, ?, ?, NULL, NULL, ?, 'claude-personal')`,
      ).run(
        event.threadId,
        T3_PROJECT,
        encoded.occurredAt,
        encoded.occurredAt,
        JSON.stringify(encoded.payload),
      );
    }
    if (event.type === "message.updated") {
      db.prepare(
        `INSERT OR REPLACE INTO orchestration_v2_projection_messages VALUES (?, ?, '{}')`,
      ).run(event.payload.id, event.threadId);
    }
  };
  return { dir, dbPath, workspaceRoot, append, close: () => db.close() };
}

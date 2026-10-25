import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  OrchestrationV2CheckpointScopeJson,
  OrchestrationV2ExecutionNodeJson,
  OrchestrationV2RunJson,
  ProjectId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projections from "./ProjectionStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const layer = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));

const threadId = ThreadId.make("thread:rehomed");
const projectId = ProjectId.make("project:rehomed");
const providerThreadId = ProviderThreadId.make("provider-thread:one");
const previousRunId = RunId.make("run:previous");
const currentRunId = RunId.make("run:current");
const previousNodeId = NodeId.make("node:previous-root");
const currentNodeId = NodeId.make("node:current-root");
const previousScopeId = CheckpointScopeId.make("scope:previous");
const currentScopeId = CheckpointScopeId.make("scope:current");
const at = "2026-10-23T03:55:23.000Z";

const encodeRun = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2RunJson));
const encodeNode = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2ExecutionNodeJson));
const encodeScope = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2CheckpointScopeJson));

const threadPayload = JSON.stringify({
  id: threadId,
  projectId,
  title: "Re-homed chat",
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: "claude",
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: "/projects/new-home",
  forkedFrom: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  deletedAt: null,
});

const runPayload = (id: RunId, ordinal: number, rootNodeId: NodeId) =>
  encodeRun({
    id,
    threadId,
    ordinal,
    providerInstanceId: "claude" as never,
    modelSelection: { instanceId: "claude", model: "claude-opus-5-5" } as never,
    providerThreadId,
    userMessageId: `message:${ordinal}` as never,
    rootNodeId,
    activeAttemptId: null,
    status: ordinal === 1 ? "completed" : "running",
    requestedAt: DateTime.makeUnsafe(at),
    startedAt: DateTime.makeUnsafe(at),
    completedAt: ordinal === 1 ? DateTime.makeUnsafe(at) : null,
    checkpointId: null,
    contextHandoffId: null,
  });

const nodePayload = (id: NodeId, runId: RunId, scopeId: CheckpointScopeId) =>
  encodeNode({
    id,
    threadId,
    runId,
    parentNodeId: null,
    rootNodeId: id,
    kind: "root_turn",
    status: "completed",
    countsForRun: true,
    providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: scopeId,
    startedAt: DateTime.makeUnsafe(at),
    completedAt: DateTime.makeUnsafe(at),
  });

const scopePayload = (id: CheckpointScopeId, runId: RunId, nodeId: NodeId, cwd: string) =>
  encodeScope({
    id,
    threadId,
    runId,
    nodeId,
    parentScopeId: null,
    providerThreadId,
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: cwd as never,
    createdAt: DateTime.makeUnsafe(at),
  });

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${projectId}, 'Project', '/projects/new-home', '[]', ${at}, ${at})`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${threadId}, ${projectId}, 'Re-homed chat', 'claude', 'full-access', 'default', ${at}, ${at}, ${threadPayload})`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json) VALUES (${previousRunId}, ${threadId}, 1, 'claude', ${providerThreadId}, 'completed', ${at}, ${at}, ${runPayload(previousRunId, 1, previousNodeId)})`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json) VALUES (${currentRunId}, ${threadId}, 2, 'claude', ${providerThreadId}, 'running', ${at}, ${at}, ${runPayload(currentRunId, 2, currentNodeId)})`;
  yield* sql`INSERT INTO orchestration_v2_projection_nodes(node_id, thread_id, run_id, parent_node_id, root_node_id, kind, status, provider_thread_id, provider_turn_id, runtime_request_id, checkpoint_scope_id, started_at, completed_at, payload_json) VALUES (${previousNodeId}, ${threadId}, ${previousRunId}, ${null}, ${previousNodeId}, 'root_turn', 'completed', ${providerThreadId}, ${null}, ${null}, ${previousScopeId}, ${at}, ${at}, ${nodePayload(previousNodeId, previousRunId, previousScopeId)})`;
  yield* sql`INSERT INTO orchestration_v2_projection_nodes(node_id, thread_id, run_id, parent_node_id, root_node_id, kind, status, provider_thread_id, provider_turn_id, runtime_request_id, checkpoint_scope_id, started_at, completed_at, payload_json) VALUES (${currentNodeId}, ${threadId}, ${currentRunId}, ${null}, ${currentNodeId}, 'root_turn', 'running', ${providerThreadId}, ${null}, ${null}, ${currentScopeId}, ${at}, ${at}, ${nodePayload(currentNodeId, currentRunId, currentScopeId)})`;
  yield* sql`INSERT INTO orchestration_v2_projection_checkpoint_scopes(scope_id, thread_id, run_id, node_id, parent_scope_id, provider_thread_id, kind, ordinal_within_parent, advances_app_run_count, created_at, payload_json) VALUES (${previousScopeId}, ${threadId}, ${previousRunId}, ${previousNodeId}, ${null}, ${providerThreadId}, 'root_run', 0, 1, ${at}, ${scopePayload(previousScopeId, previousRunId, previousNodeId, "/scratch/old-home")})`;
  yield* sql`INSERT INTO orchestration_v2_projection_checkpoint_scopes(scope_id, thread_id, run_id, node_id, parent_scope_id, provider_thread_id, kind, ordinal_within_parent, advances_app_run_count, created_at, payload_json) VALUES (${currentScopeId}, ${threadId}, ${currentRunId}, ${currentNodeId}, ${null}, ${providerThreadId}, 'root_run', 0, 1, ${at}, ${scopePayload(currentScopeId, currentRunId, currentNodeId, "/projects/new-home")})`;
});

describe("SQL getTurnStartContext", () => {
  it.effect("loads the previous started run's root node and checkpoint scope", () =>
    Effect.gen(function* () {
      yield* seed;
      const projections = yield* Projections.ProjectionStoreV2;
      const context = yield* projections.getTurnStartContext(threadId, currentRunId);
      // The current run's own root node is there, as before.
      expect(context.nodes.map((node) => node.id)).toContain(currentNodeId);
      // The previous started run's root node and its scope must be there too:
      // ProviderTurnStartService compares that scope's cwd with the new cwd
      // to decide that a re-homed chat needs a fresh provider session.
      expect(context.nodes.map((node) => node.id)).toContain(previousNodeId);
      const previousRootNode = context.nodes.find((node) => node.id === previousNodeId);
      const previousScope = context.checkpointScopes.find(
        (scope) => scope.id === previousRootNode?.checkpointScopeId,
      );
      expect(previousScope?.cwd).toBe("/scratch/old-home");
      const run = context.runs.find((candidate) => candidate.id === currentRunId)!;
      const previousStartedRun = context.runs.findLast(
        (source) =>
          source.ordinal < run.ordinal &&
          source.startedAt !== null &&
          source.providerThreadId === run.providerThreadId,
      );
      expect(
        RuntimePolicy.providerSessionCwdChanged({
          previousCwd: previousScope?.cwd,
          nextCwd: context.thread.worktreePath,
          hasPriorStartedRun: previousStartedRun !== undefined,
        }),
      ).toBe(true);
    }).pipe(Effect.provide(Layer.provideMerge(Projections.layer, layer))),
  );
});

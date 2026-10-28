import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projections from "./ProjectionStore.ts";

const layer = Projections.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(NodeServices.layer),
);
const projectId = ProjectId.make("p");
const at = "2026-01-01T00:00:00.000Z";
const threadPayload = (id: ThreadId, fork: { threadId: ThreadId; runId: string } | null) =>
  JSON.stringify({
    id,
    projectId,
    title: id,
    createdBy: fork === null ? "user" : "agent",
    creationSource: fork === null ? "web" : "provider",
    providerInstanceId: "claude",
    modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    forkedFrom: fork === null ? null : { type: "run", ...fork },
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: fork?.threadId ?? null,
      relationshipToParent: fork === null ? null : "fork",
      rootThreadId: fork?.threadId ?? id,
    },
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    deletedAt: null,
  });

it.effect("groups selected counts, excludes rollback/missing runs, and retains fork prefixes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* Projections.ProjectionStoreV2;
    yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${projectId}, 'Project', '/repo', '[]', ${at}, ${at})`;
    const parent = ThreadId.make("parent");
    for (const id of [parent, ThreadId.make("empty"), ThreadId.make("fork")]) {
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${id}, ${projectId}, ${id}, 'claude', 'full-access', 'default', ${at}, ${at}, ${threadPayload(id, id === "fork" ? { threadId: parent, runId: "kept" } : null)})`;
    }
    for (const [run, ordinal, status] of [
      ["kept", 1, "completed"],
      ["rolled", 2, "rolled_back"],
      ["later", 3, "completed"],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json) VALUES (${run}, 'parent', ${ordinal}, 'claude', ${status}, ${at}, ${at}, '{}')`;
    }
    let ordinal = 0;
    for (const [id, run] of [
      ["parent", null],
      ["parent", "kept"],
      ["parent", "kept"],
      ["parent", "rolled"],
      ["parent", "missing"],
      ["parent", "later"],
      ["fork", null],
    ] as const) {
      ordinal++;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items(turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json) VALUES (${`item:${ordinal}`}, ${id}, ${run}, ${ordinal}, 'assistant_message', 'completed', ${at}, '{}')`;
    }
    const snapshot = yield* projections.getShellSnapshot({ projectId, location: "active" });
    for (const [id, count, visibleCount] of [
      ["parent", 4, 4],
      ["empty", 0, 0],
      ["fork", 1, 4],
    ] as const) {
      const shell = yield* projections.getThreadShell(ThreadId.make(id));
      expect(shell).toMatchObject({ itemCount: count, visibleItemCount: visibleCount });
      expect(snapshot.threads.find((row) => row.id === id)).toEqual(shell);
    }
    expect(
      (yield* projections.getShellSnapshot({ projectId: ProjectId.make("missing") })).threads,
    ).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

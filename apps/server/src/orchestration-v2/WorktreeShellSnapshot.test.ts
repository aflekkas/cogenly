import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projections from "./ProjectionStore.ts";

const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));
const layer = Events.layer.pipe(Layer.provideMerge(database), Layer.provide(NodeServices.layer));

it.effect("worktree snapshots keep active and archived owners and skip unrelated histories", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = "2026-10-23T03:55:23.000Z";
    yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('project', 'Project', '/repo', '[]', ${at}, ${at})`;
    for (const [id, worktreePath, archivedAt, deletedAt] of [
      ["owner", "/worktrees/shared", null, null],
      ["archived", "/worktrees/shared", at, null],
      ["chat", null, null, null],
      ["deleted", "/worktrees/deleted", null, at],
    ] as const) {
      const payload = JSON.stringify({
        id,
        projectId: "project",
        title: id,
        createdBy: "user",
        creationSource: "web",
        providerInstanceId: "claude",
        modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "work",
        worktreePath,
        forkedFrom: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
        createdAt: at,
        updatedAt: at,
        archivedAt,
        deletedAt,
      });
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, deleted_at, payload_json) VALUES (${id}, 'project', ${id}, 'claude', 'full-access', 'default', ${at}, ${at}, ${deletedAt}, ${payload})`;
    }
    const projections = yield* Projections.ProjectionStoreV2.pipe(
      Effect.provide(Projections.layer),
    );
    const full = yield* projections.getShellSnapshot();
    const worktrees = yield* projections.getShellSnapshot({ worktreesOnly: true });
    expect(worktrees.threads).toEqual(
      full.threads.filter((thread) => thread.worktreePath !== null),
    );
    expect(worktrees.archivedThreads).toEqual(
      full.archivedThreads.filter((thread) => thread.worktreePath !== null),
    );
    expect(worktrees.threads.map((t) => t.id)).toEqual(["owner"]);
    expect(worktrees.archivedThreads.map((t) => t.id)).toEqual(["archived"]);
    // Skipped chats must not even be decoded: corrupt unrelated history cannot
    // prevent a storage report or worktree sweep.
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{"worktreePath":null}' WHERE thread_id = 'chat'`;
    expect((yield* projections.getShellSnapshot({ worktreesOnly: true })).threads).toEqual(
      worktrees.threads,
    );
  }).pipe(Effect.provide(layer)),
);

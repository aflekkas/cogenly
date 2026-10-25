import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projections from "./ProjectionStore.ts";
import { coalesceShellApplicationEvents, toShellApplicationEvent } from "./ShellStream.ts";

const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));
const layer = Events.layer.pipe(Layer.provideMerge(database), Layer.provide(NodeServices.layer));

const parentId = ThreadId.make("thread:native-parent");
const childId = ThreadId.make("thread:native-child");
const projectId = ProjectId.make("project:native-subagent");
const at = "2026-10-23T03:55:23.000Z";

const threadPayload = (id: ThreadId, parent: ThreadId | null) =>
  JSON.stringify({
    id,
    projectId,
    title: id,
    createdBy: parent === null ? "user" : "agent",
    creationSource: parent === null ? "web" : "provider",
    providerInstanceId: "claude",
    modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    forkedFrom: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: parent,
      relationshipToParent: parent === null ? null : "subagent",
      rootThreadId: parent ?? id,
    },
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    deletedAt: null,
  });

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${projectId}, 'Project', '/repos/project', '[]', ${at}, ${at})`;
  for (const [id, parent] of [
    [parentId, null],
    [childId, parentId],
  ] as const) {
    yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${id}, ${projectId}, ${id}, 'claude', 'full-access', 'default', ${at}, ${at}, ${threadPayload(id, parent)})`;
  }
});

const setTask = (status: string, completedAt: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_subagents (
        subagent_id, thread_id, parent_node_id, provider, child_thread_id,
        origin, status, started_at, completed_at, updated_at, payload_json
      )
      VALUES (
        'node:native-task', ${parentId}, 'node:parent-root', 'claude', ${childId},
        'provider_native', ${status}, ${at}, ${completedAt}, ${completedAt ?? at}, '{}'
      )
      ON CONFLICT(subagent_id) DO UPDATE SET
        status = excluded.status,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
    `;
  });

describe("provider-native subagent conversations", () => {
  it.effect("work while their task runs and settle when it ends", () =>
    Effect.gen(function* () {
      yield* seed;
      const projections = yield* Projections.ProjectionStoreV2.pipe(
        Effect.provide(Projections.layer),
      );
      // No task record: a run-less conversation is idle.
      expect(yield* projections.getThreadShell(childId)).toMatchObject({
        status: "idle",
        activityRunStatus: null,
      });

      yield* setTask("running", null);
      expect(yield* projections.getThreadShell(childId)).toMatchObject({
        status: "running",
        activityRunStatus: "running",
        latestRunId: null,
        latestRunCompletedAt: null,
      });
      // The parent, with no runs of its own here, is not the task's conversation.
      expect(yield* projections.getThreadShell(parentId)).toMatchObject({ status: "idle" });

      const completedAt = "2026-10-23T04:01:00.000Z";
      yield* setTask("completed", completedAt);
      const settled = yield* projections.getThreadShell(childId);
      expect(settled).toMatchObject({ status: "completed", activityRunStatus: null });
      expect(
        settled?.latestRunCompletedAt ? DateTime.formatIso(settled.latestRunCompletedAt) : null,
      ).toBe(completedAt);
      // The full snapshot agrees with the per-thread read.
      expect(
        (yield* projections.getShellSnapshot()).threads.find((thread) => thread.id === childId),
      ).toMatchObject({ status: "completed" });
    }).pipe(Effect.provide(layer)),
  );
});

describe("shell stream", () => {
  it("refreshes a native subagent's conversation when its task record changes", () => {
    const stored = (sequence: number, threadId: ThreadId, childThreadId: ThreadId | null) =>
      ({
        sequence,
        event: {
          type: "subagent.updated",
          threadId,
          payload: { childThreadId },
        },
      }) as never;
    const events = [
      toShellApplicationEvent(stored(1, parentId, childId)),
      toShellApplicationEvent(stored(2, parentId, null)),
    ];
    const threadIds = coalesceShellApplicationEvents(events).map((event) =>
      "aggregateKind" in event ? null : event.event.threadId,
    );
    expect(threadIds).toEqual([childId, parentId]);
  });

  it("keeps a newer event of the related thread over an older related refresh", () => {
    const events = [
      { sequence: 5, event: { threadId: childId } },
      { sequence: 3, event: { threadId: parentId }, relatedThreadIds: [childId] },
    ];
    const coalesced = coalesceShellApplicationEvents(events);
    expect(
      coalesced.map((event) =>
        "aggregateKind" in event ? null : [event.event.threadId, event.sequence],
      ),
    ).toEqual([
      [parentId, 3],
      [childId, 5],
    ]);
  });
});

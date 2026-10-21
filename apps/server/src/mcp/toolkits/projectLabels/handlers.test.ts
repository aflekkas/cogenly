import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectLabelId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Labels from "../../../projectLabels/ProjectLabelService.ts";
import * as Clones from "../../../project/ProjectCloneTracker.ts";
import * as Projects from "../../../project/ProjectService.ts";
import * as Identities from "../../../project/RepositoryIdentityResolver.ts";
import * as Settings from "../../../serverSettings.ts";
import * as Broadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { ProjectLabelsToolkit } from "./tools.ts";

// The clone tool's services resolve at layer build even for tests that never clone.
const cloneDependencies = Layer.mergeAll(
  Layer.mock(Clones.ProjectCloneTracker)({}),
  Layer.mock(Projects.ProjectService)({}),
  Layer.mock(Identities.RepositoryIdentityResolver)({}),
  Layer.mock(Settings.ServerSettingsService)({}),
  Layer.mock(Broadcaster.VcsStatusBroadcaster)({}),
  NodeServices.layer,
);

it.effect.each([
  { access: "read-only" as const, code: "capability_denied" },
  { access: "approval-required" as const, code: undefined },
  { access: "full-access" as const, code: undefined },
])(
  "keeps the caller's $access limits when filing a thread into a project folder",
  ({ access, code }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("shared-context-thread");
      const labelId = ProjectLabelId.make("shared-label");
      const writes: Array<{ folderId: ProjectLabelId | null }> = [];
      const dependencies = Layer.mergeAll(
        Layer.succeed(Invocation.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment"),
          capabilities: new Set(["orchestration" as const]),
          requestNamespace: "test",
          issuedAt: 0,
          thread: undefined,
          client: { sessionId: "session", label: "Agent", access },
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
        }),
        Layer.mock(Labels.ProjectLabelService)({
          moveThread: (input) =>
            Effect.sync(() => {
              writes.push({ folderId: input.folderId });
              return { threadId: input.threadId, projectFolderId: input.folderId };
            }),
        }),
        cloneDependencies,
      );
      const toolkit = yield* ProjectLabelsToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const results = yield* toolkit
        .handle("t3_thread_move_project_folder", { threadId, folderId: labelId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      if (code) {
        expect(results.at(-1)?.result).toMatchObject({ code });
        expect(writes).toEqual([]);
      } else {
        expect(results.at(-1)?.result).toMatchObject({
          threadId,
          projectFolderId: labelId,
        });
        expect(writes).toEqual([{ folderId: labelId }]);
      }
    }),
);

const labelShape = {
  id: ProjectLabelId.make("label:new"),
  name: "Spawn Partners",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  repositoryIds: [],
  sourceLinks: [],
  threadCount: 0,
};

it.effect.each([
  { access: "read-only" as const, code: "capability_denied" },
  { access: "approval-required" as const, code: undefined },
  { access: "full-access" as const, code: undefined },
])("keeps the caller's $access limits when creating a project folder", ({ access, code }) =>
  Effect.gen(function* () {
    const created: Array<string> = [];
    const dependencies = Layer.mergeAll(
      Layer.succeed(Invocation.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        capabilities: new Set(["orchestration" as const]),
        requestNamespace: "test",
        issuedAt: 0,
        thread: undefined,
        client: { sessionId: "session", label: "Agent", access },
      }),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
      }),
      Layer.mock(Labels.ProjectLabelService)({
        create: (input) =>
          Effect.sync(() => {
            created.push(input.name);
            return { label: { ...labelShape, name: input.name } };
          }),
      }),
      cloneDependencies,
    );
    const toolkit = yield* ProjectLabelsToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const results = yield* toolkit
      .handle("t3_project_label_create", { name: "Spawn Partners" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    if (code) {
      expect(results.at(-1)?.result).toMatchObject({ code });
      expect(created).toEqual([]);
    } else {
      expect(results.at(-1)?.result).toMatchObject({ label: { name: "Spawn Partners" } });
      expect(created).toEqual(["Spawn Partners"]);
    }
  }),
);

it.effect("lets a chat-surface thread organize project folders", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:chat-organizer");
    const shell = { ...liveThreadShell(threadId), surface: "chat" as const };
    const dependencies = Layer.mergeAll(
      Layer.succeed(Invocation.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        capabilities: new Set(["orchestration" as const]),
        requestNamespace: "test",
        issuedAt: 0,
        thread: {
          threadId,
          providerSessionId: "session",
          providerInstanceId: shell.providerInstanceId,
        },
        client: undefined,
      }),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(id === threadId ? shell : null),
      }),
      Layer.mock(Labels.ProjectLabelService)({
        create: (input) => Effect.succeed({ label: { ...labelShape, name: input.name } }),
      }),
      cloneDependencies,
    );
    const toolkit = yield* ProjectLabelsToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const results = yield* toolkit
      .handle("t3_project_label_create", { name: "Spawn Partners" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(results.at(-1)?.result).toMatchObject({ label: { name: "Spawn Partners" } });
  }),
);

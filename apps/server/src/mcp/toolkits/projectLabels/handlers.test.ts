import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectLabelError,
  ProjectLabelId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
  instructions: "",
  projectChatThreadId: null,
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

const fileSetup = (input: {
  readonly turned: boolean;
  readonly access?: "read-only" | "full-access";
}) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:file-source");
    const labelId = ProjectLabelId.make("label:file-target");
    const moved: Array<ThreadId> = [];
    const dispatched: Array<string> = [];
    const dependencies = Layer.mergeAll(
      Layer.succeed(Invocation.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        capabilities: new Set(["orchestration" as const]),
        requestNamespace: "test",
        issuedAt: 0,
        thread: undefined,
        client: { sessionId: "session", label: "Agent", access: input.access ?? "full-access" },
      }),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
        getThreadRecords: (id) =>
          Effect.succeed({
            thread: {
              id,
              deletedAt: null,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
            } as unknown as OrchestrationV2AppThread,
            runs: input.turned ? [{ status: "completed" } as OrchestrationV2Run] : [],
          }) as never,
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command.type);
            return { sequence: 1, storedEvents: [] };
          }) as never,
      }),
      Layer.mock(Labels.ProjectLabelService)({
        readActive: (id) => Effect.succeed({ label: { ...labelShape, id } }),
        list: () => Effect.succeed({ labels: [] }),
        // Mirrors the server gate: a chat with turns cannot be re-parented,
        // but its turnless fork can.
        moveThread: (move) =>
          input.turned && move.threadId === threadId
            ? Effect.fail(
                new ProjectLabelError({ operation: "moveThread", reason: "fork_required" }),
              )
            : Effect.sync(() => {
                moved.push(move.threadId);
                return { threadId: move.threadId, projectFolderId: move.folderId };
              }),
        setThreadLabels: (labels) =>
          input.turned && labels.threadId === threadId
            ? Effect.fail(
                new ProjectLabelError({ operation: "moveThread", reason: "fork_required" }),
              )
            : Effect.succeed({ labels: [] }),
      }),
      cloneDependencies,
    );
    const toolkit = yield* ProjectLabelsToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    return { toolkit, dependencies, threadId, labelId, moved, dispatched };
  });

it.effect("files a turnless chat or Work thread into a project in place", () =>
  Effect.gen(function* () {
    const { toolkit, dependencies, threadId, labelId, moved, dispatched } = yield* fileSetup({
      turned: false,
    });
    const results = yield* toolkit
      .handle("t3_project_label_file_thread", { threadId, labelId })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(results.at(-1)?.result).toMatchObject({
      threadId,
      sourceThreadId: threadId,
      projectFolderId: labelId,
      forked: false,
    });
    expect(moved).toEqual([threadId]);
    expect(dispatched).toEqual([]);
  }),
);

it.effect("forks a chat with turns into the project and leaves the original in place", () =>
  Effect.gen(function* () {
    const { toolkit, dependencies, threadId, labelId, moved, dispatched } = yield* fileSetup({
      turned: true,
    });
    const results = yield* toolkit
      .handle("t3_project_label_file_thread", { threadId, labelId })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    const result = results.at(-1)?.result as { threadId: ThreadId; message: string };
    expect(result).toMatchObject({
      sourceThreadId: threadId,
      projectFolderId: labelId,
      forked: true,
    });
    expect(result.threadId).not.toBe(threadId);
    expect(result.message).toContain("original chat was left in place");
    expect(dispatched).toEqual(["thread.fork"]);
    expect(moved).toEqual([result.threadId]);
  }),
);

it.effect("keeps read-only callers from filing threads into a project", () =>
  Effect.gen(function* () {
    const { toolkit, dependencies, threadId, labelId, moved, dispatched } = yield* fileSetup({
      turned: true,
      access: "read-only",
    });
    const results = yield* toolkit
      .handle("t3_project_label_file_thread", { threadId, labelId })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(results.at(-1)?.result).toMatchObject({ code: "capability_denied" });
    expect(moved).toEqual([]);
    expect(dispatched).toEqual([]);
  }),
);

it.effect.each([
  { tool: "t3_thread_move_project_folder" as const },
  { tool: "t3_thread_set_project_labels" as const },
])("$tool refuses to re-parent a chat with turns and points at the fork", ({ tool }) =>
  Effect.gen(function* () {
    const { toolkit, dependencies, threadId, labelId, moved, dispatched } = yield* fileSetup({
      turned: true,
    });
    const last =
      tool === "t3_thread_move_project_folder"
        ? yield* toolkit.handle(tool, { threadId, folderId: labelId }).pipe(
            Stream.unwrap,
            Stream.runLast,
            Effect.map((last) => Option.getOrUndefined(last)?.result),
            Effect.provide(dependencies),
          )
        : yield* toolkit.handle(tool, { threadId, labelIds: [labelId] }).pipe(
            Stream.unwrap,
            Stream.runLast,
            Effect.map((last) => Option.getOrUndefined(last)?.result),
            Effect.provide(dependencies),
          );
    expect(last).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("t3_project_label_file_thread"),
    });
    expect(moved).toEqual([]);
    expect(dispatched).toEqual([]);
  }),
);

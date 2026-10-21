import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  AgentId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProjectLabelId,
  ProviderInstanceId,
  RuntimeMode,
  type ServerProvider,
  ThreadId,
  type ThreadSurface,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectFiles from "../projectLabels/ProjectFiles.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const decodeRuntimeMode = Schema.decodeUnknownSync(RuntimeMode);

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: typeof RuntimeMode.Encoded;
  readonly surface?: ThreadSurface;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    ...(input.surface === undefined ? {} : { surface: input.surface }),
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: decodeRuntimeMode(input.runtimeMode ?? "full-access"),
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

// Stale or empty provider capability snapshots cannot restore runtime gating.
const grokInstanceId = ProviderInstanceId.make("grok");
const supervisedOnlyInstanceId = ProviderInstanceId.make("supervised-only");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["full-access"]],
  [supervisedOnlyInstanceId, []],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as ProviderInstance;

const layerTest = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "Project",
            workspaceRoot: "/project-root",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
  ),
);

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("uses the project root for local-checkout threads", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-root");
    }),
  );

  it.effect("prefers a provisioned worktree over the project root", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/project-worktree" }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
    }),
  );

  it.effect("normalizes every legacy thread mode to full access", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: typeof RuntimeMode.Encoded) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      for (const runtimeMode of [
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ] as const) {
        assert.equal(yield* modeFor(providerInstanceId, runtimeMode), "full-access");
      }
      // Legacy input normalizes independently of provider capability snapshots.
      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "full-access");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      // Empty capability snapshots do not reduce access.
      assert.equal(yield* modeFor(supervisedOnlyInstanceId, "full-access"), "full-access");
    }),
  );

  it.effect("runs chat and work with full access", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (surface: "chat" | "work") =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode: "full-access", surface }),
            modelSelection,
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor("chat"), "full-access");
      assert.equal(yield* modeFor("work"), "full-access");
    }),
  );

  it.effect("marks chat and builder threads for conversation mode", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const conversationFor = (surface?: "chat" | "work" | "builder") =>
        policy
          .resolve({
            thread: makeThread({
              now,
              worktreePath: null,
              ...(surface === undefined ? {} : { surface }),
            }),
            modelSelection,
          })
          .pipe(Effect.map((resolved) => resolved.conversationMode));

      assert.isTrue(yield* conversationFor("chat"));
      assert.isTrue(yield* conversationFor("builder"));
      assert.isUndefined(yield* conversationFor("work"));
      assert.isUndefined(yield* conversationFor(undefined));
    }),
  );

  it.effect("omits the project manifest without the files service", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null, surface: "chat" }),
        modelSelection,
      });
      assert.isUndefined(resolved.projectManifest);
    }),
  );

  it.effect("keeps scratch cwd for chats without a project", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const chat = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/scratch/chat", surface: "chat" }),
        modelSelection,
      });
      assert.equal(chat.cwd, "/scratch/chat");
    }),
  );
});

const filedLabelId = ProjectLabelId.make("label:manifest");

const layerWithFiles = layerTest.pipe(
  Layer.provideMerge(
    Layer.mock(ProjectFiles.ProjectFiles)({
      folderForThread: (threadId) =>
        Effect.succeed(
          ThreadId.make("thread:runtime-policy") === threadId
            ? {
                labelId: filedLabelId,
                name: "Manifest",
                dir: "/projects/Manifest",
              }
            : null,
        ),
      manifestEntries: () =>
        Effect.succeed({ entries: ["Resources/brief.md", "notes.md"], total: 2 }),
    }),
  ),
);

it.layer(layerWithFiles)("RuntimePolicyV2 project manifest", (it) => {
  it.effect("resolves a manifest for threads filed in a project", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null, surface: "work" }),
        modelSelection,
      });
      assert.include(resolved.projectManifest ?? "", "<project_manifest>");
      assert.include(resolved.projectManifest ?? "", '"Manifest" at /projects/Manifest');
      assert.include(resolved.projectManifest ?? "", "- Resources/brief.md");
      assert.include(resolved.projectManifest ?? "", "project_recall");
    }),
  );

  it.effect("runs a filed chat with the project dir as cwd", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      // Even when the chat keeps a scratch worktree path from before filing.
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/scratch/chat", surface: "chat" }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/projects/Manifest");
    }),
  );

  it.effect("runs a filed agent conversation with the project dir as cwd", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const thread = makeThread({ now, worktreePath: "/scratch/agent" });
      const resolved = yield* policy.resolve({
        thread: { ...thread, agent: { id: AgentId.make("agent:filed"), role: "conversation" } },
        modelSelection,
      });
      assert.equal(resolved.cwd, "/projects/Manifest");
      assert.include(resolved.projectManifest ?? "", "<project_manifest>");
    }),
  );

  it.effect("keeps worktree cwd for filed work threads", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const work = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/repo/worktree", surface: "work" }),
        modelSelection,
      });
      assert.equal(work.cwd, "/repo/worktree");
    }),
  );
});

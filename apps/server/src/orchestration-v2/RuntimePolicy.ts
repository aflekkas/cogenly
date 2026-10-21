import {
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { buildProjectManifest } from "@t3tools/provider-core/server/runtimeInstructions";
import * as ProjectFiles from "../projectLabels/ProjectFiles.ts";
import * as ProjectStore from "./ProjectStore.ts";

/**
 * ERRORS
 */
export class RuntimePolicyResolveError extends Schema.TaggedError<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`;
  }
}

export const RuntimePolicyV2Error = Schema.Union([RuntimePolicyResolveError]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

/**
 * SERVICE DEFINITION
 */
export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

/**
 * IMPLEMENTATIONS
 */
/**
 * Chat-surface threads run in conversation mode: adapters offer
 * conversation-only tools (no file writes, no shell) plus a conversational
 * system prompt. Builder threads are conversations too. Every other thread
 * keeps the full work toolset.
 */
const conversationModeFor = (
  thread: OrchestrationV2AppThread,
): Pick<ProviderAdapter.ProviderAdapterV2RuntimePolicy, "conversationMode"> =>
  thread.surface === "chat" || thread.surface === "builder" ? { conversationMode: true } : {};

export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: (input) =>
    Effect.succeed({
      runtimeMode: "full-access",
      interactionMode: input.thread.interactionMode,
      cwd: input.thread.worktreePath,
      ...conversationModeFor(input.thread),
    }),
});

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  ProjectStore.ProjectStoreV2 | ProviderInstanceRegistry.ProviderInstanceRegistry
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    // Optional so layers without the project-files service (unit tests over a
    // memory database) still resolve; production always provides it.
    const files = yield* Effect.serviceOption(ProjectFiles.ProjectFiles);
    // The project context is best-effort turn context from the derived index:
    // any failure resolves to no folder rather than failing the turn.
    const projectFor = (
      thread: OrchestrationV2AppThread,
    ): Effect.Effect<{ readonly dir: string; readonly manifest: string } | undefined, never> =>
      Option.isNone(files)
        ? Effect.succeed(undefined)
        : Effect.gen(function* () {
            const folder = yield* files.value.folderForThread(thread.id);
            if (folder === null) return undefined;
            const { entries, total } = yield* files.value.manifestEntries(folder.labelId);
            return {
              dir: folder.dir,
              manifest: buildProjectManifest({
                name: folder.name,
                directory: folder.dir,
                resources: entries,
                total,
              }),
            };
          }).pipe(
            Effect.catch((cause) =>
              Effect.logDebug("Project lookup failed; resolving without it.", {
                threadId: thread.id,
                cause,
              }).pipe(Effect.as(undefined)),
            ),
          );
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        const project = yield* projectFor(input.thread);
        // A chat or an agent's conversation filed in a project runs with the
        // project dir as its working directory, even when the thread keeps a
        // scratch worktree path from before it was filed. Unfiled ones keep
        // scratch, and Work in a repo still runs in that repo's worktree.
        const cwd =
          (input.thread.surface === "chat" || input.thread.agent?.role === "conversation") &&
          project !== undefined
            ? project.dir
            : (input.thread.worktreePath ??
              (yield* projects.get(input.thread.projectId).pipe(
                Effect.mapError(
                  (cause) =>
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause,
                    }),
                ),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(
                        new RuntimePolicyResolveError({
                          projectId: input.thread.projectId,
                          providerInstanceId: input.modelSelection.instanceId,
                          cause: "Project not found.",
                        }),
                      ),
                    onSome: (project) => Effect.succeed(project.workspaceRoot),
                  }),
                ),
              )));
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: input.thread.interactionMode,
          cwd,
          ...conversationModeFor(input.thread),
          ...(project === undefined ? {} : { projectManifest: project.manifest }),
        });
      }),
    });
  }),
);

export function layerWithOverride(
  override: RuntimePolicyV2Override,
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.map((policy) =>
              ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                ...policy,
                ...(override.cwd === undefined ? {} : { cwd: override.cwd }),
                ...(override.approvalPolicy === undefined
                  ? {}
                  : { approvalPolicy: override.approvalPolicy }),
                ...(override.sandboxPolicy === undefined
                  ? {}
                  : { sandboxPolicy: override.sandboxPolicy }),
                ...(override.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: override.reasoningEffort }),
              }),
            ),
          ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}

import {
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  type ProjectLabelId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  buildIntegrationsContextLine,
  buildProjectManifest,
} from "@t3tools/provider-core/server/runtimeInstructions";
import { buildMachineHealthContextLine } from "@t3tools/provider-core/server/machineHealthContext";
import * as HealthAlertsState from "../health/HealthAlertsState.ts";
import { availableToConnect } from "../integrations/IntegrationCatalog.ts";
import * as Integrations from "../integrations/Integrations.ts";
import * as ProjectFiles from "../projectLabels/ProjectFiles.ts";
import * as ServerSettings from "../serverSettings.ts";
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
  "cogenly-server/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

/**
 * IMPLEMENTATIONS
 */
/**
 * Chat-surface threads run in conversation mode: adapters drop native file
 * writes, shell and delegation, and add a conversational system prompt.
 * Builders share those native restrictions but get setup instructions and
 * cannot run terminal commands. Every other thread keeps the work toolset.
 */
const conversationModeFor = (
  thread: OrchestrationV2AppThread,
): Pick<ProviderAdapter.ProviderAdapterV2RuntimePolicy, "conversationMode" | "builderMode"> =>
  thread.surface === "chat" || thread.surface === "builder"
    ? { conversationMode: true, ...(thread.surface === "builder" ? { builderMode: true } : {}) }
    : {};

/**
 * A chat or an agent's conversation filed in a project works in the project
 * folder, even when the thread keeps a scratch worktree path from before it
 * was filed. The provider cwd and the agent terminal root both follow this.
 */
export const worksInProjectFolder = (
  thread: Pick<OrchestrationV2AppThread, "surface" | "agent">,
): boolean => thread.surface === "chat" || thread.agent?.role === "conversation";

/**
 * Whether a provider session opened in `previousCwd` must give way to a
 * fresh session in `nextCwd`: provider sessions are keyed by cwd, so a
 * thread re-homed into a project (or back to its scratch folder) cannot
 * resume the session it ran in before. Only a thread with started history
 * needs the fresh session seeded; a first turn simply opens where it is.
 */
export function providerSessionCwdChanged(input: {
  readonly previousCwd: string | null | undefined;
  readonly nextCwd: string | null | undefined;
  readonly hasPriorStartedRun: boolean;
}): boolean {
  return (
    input.hasPriorStartedRun &&
    typeof input.previousCwd === "string" &&
    input.previousCwd.length > 0 &&
    typeof input.nextCwd === "string" &&
    input.nextCwd.length > 0 &&
    input.previousCwd !== input.nextCwd
  );
}

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
  | ProjectStore.ProjectStoreV2
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | Integrations.Integrations
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    // Optional so layers without the project-files service (unit tests over a
    // memory database) still resolve; production always provides it.
    const files = yield* Effect.serviceOption(ProjectFiles.ProjectFiles);
    // Required, not optional: as an optional service the production runtime
    // silently never received it and turns lost the integrations line.
    const integrationsService = yield* Integrations.Integrations;
    const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    // Unreadable settings keep the default: provider duplicates stay hidden.
    const useProviderConnectors = Option.isNone(serverSettings)
      ? Effect.succeed(false)
      : serverSettings.value.getSettings.pipe(
          Effect.map(
            (settings) => settings.useProviderConnectors || !settings.nativeMcpImportReviewed,
          ),
          Effect.orElseSucceed(() => false),
        );
    // The integrations line is best-effort turn context too: any failure
    // resolves to no line rather than failing the turn.
    const noIntegrations = { integrations: [], available: [] };
    const integrationsFor = (labelId: ProjectLabelId | null) =>
      integrationsService.contextIntegrations(labelId).pipe(
        Effect.map((found) => ({
          integrations: found.map((integration) => ({
            name: integration.name,
            status: integration.status,
            displayName: integration.displayName,
            hint: integration.hint,
            accountLabel: integration.accountLabel,
          })),
          available: availableToConnect(found),
        })),
        Effect.orElseSucceed(() => noIntegrations),
      );
    // Best-effort like the integrations line: open health alerts, here and on
    // paired machines. TODO(machines-context): move into the machines context
    // block once it lands.
    const healthAlerts = yield* Effect.serviceOption(HealthAlertsState.HealthAlertsState);
    const machineHealthLine = Option.isNone(healthAlerts)
      ? Effect.succeed(null)
      : healthAlerts.value.current.pipe(
          Effect.map((snapshot) => buildMachineHealthContextLine(snapshot.open)),
          Effect.catchCause(() => Effect.succeed(null)),
        );
    // The project context is best-effort turn context from the derived index:
    // any failure resolves to no folder rather than failing the turn.
    const projectFor = (
      thread: OrchestrationV2AppThread,
      providerConnectorsHidden: boolean,
    ): Effect.Effect<
      | { readonly dir: string; readonly manifest: string; readonly labelId: ProjectLabelId }
      | undefined,
      never
    > =>
      Option.isNone(files)
        ? Effect.succeed(undefined)
        : Effect.gen(function* () {
            const folder = yield* files.value.folderForThread(thread.id);
            if (folder === null) return undefined;
            const { entries, total } = yield* files.value.manifestEntries(folder.labelId);
            const { integrations, available } = yield* integrationsFor(folder.labelId);
            return {
              dir: folder.dir,
              labelId: folder.labelId,
              manifest: buildProjectManifest({
                name: folder.name,
                directory: folder.dir,
                resources: entries,
                total,
                instructions: folder.instructions,
                projectChat: folder.projectChatThreadId === thread.id,
                integrations,
                availableIntegrations: available,
                providerConnectorsHidden,
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
        const providerConnectors = yield* useProviderConnectors;
        const project = yield* projectFor(input.thread, !providerConnectors);
        // A chat or an agent's conversation filed in a project runs with the
        // project dir as its working directory, even when the thread keeps a
        // scratch worktree path from before it was filed. Unfiled ones keep
        // scratch, and Work in a repo still runs in that repo's worktree.
        const cwd =
          worksInProjectFolder(input.thread) && project !== undefined
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
        // Unfiled threads still get the integrations line on its own, so
        // every provider turn names what is connected.
        const standalone = project === undefined ? yield* integrationsFor(null) : noIntegrations;
        const standaloneLine = buildIntegrationsContextLine(
          standalone.integrations,
          standalone.available,
          !providerConnectors,
        );
        const manifest =
          project !== undefined
            ? project.manifest
            : standaloneLine.length > 0
              ? standaloneLine
              : undefined;
        const healthLine = yield* machineHealthLine;
        const projectManifest =
          healthLine === null
            ? manifest
            : manifest === undefined
              ? healthLine
              : `${manifest}\n${healthLine}`;
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: input.thread.interactionMode,
          cwd,
          ...conversationModeFor(input.thread),
          ...(providerConnectors ? { useProviderConnectors: true } : {}),
          ...(projectManifest === undefined ? {} : { projectManifest }),
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

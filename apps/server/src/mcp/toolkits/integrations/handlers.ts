import * as SetupRequests from "../../../integrations/IntegrationSetupRequests.ts";
import {
  IntegrationAddInput,
  IntegrationError,
  OrchestratorMcpFailure,
  type ProjectLabelId,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Integrations from "../../../integrations/Integrations.ts";
import * as AgentStore from "../../../agents/AgentStore.ts";
import * as ProjectFiles from "../../../projectLabels/ProjectFiles.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import { catalogRequest } from "../../../integrations/IntegrationCatalog.ts";
import {
  agentFailureMessage,
  agentSummary,
  withAgentNextStep,
} from "../../../integrations/IntegrationSetup.ts";
import { IntegrationsToolkit } from "./tools.ts";

const isIntegrationError = Schema.is(IntegrationError);
const decodeAdd = Schema.decodeUnknownEffect(IntegrationAddInput);

/** A failure in the same words Settings uses for it; the inline card carries the fix. */
const failure = (cause: unknown): OrchestratorMcpFailure => {
  if (!isIntegrationError(cause))
    return new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: "The integration request could not be completed.",
    });
  const waiting = Integrations.refreshWaitMessage(cause);
  if (waiting !== undefined)
    return new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `${waiting} The integration works again once that machine is online and its refreshed sign-in syncs here; try again later.`,
    });
  const { message, transient } = agentFailureMessage(cause);
  return new OrchestratorMcpFailure({
    code: transient ? "orchestration_error" : "invalid_request",
    message,
  });
};

/** A catalog request's next step (an account label, a vault reference) is the agent's message. */
const catalogFailure = (cause: unknown): OrchestratorMcpFailure =>
  isIntegrationError(cause) && cause.reason === "invalid_request" && typeof cause.cause === "string"
    ? new OrchestratorMcpFailure({ code: "invalid_request", message: cause.cause })
    : failure(cause);

/**
 * The caller's project scope: a thread caller sees integrations for its
 * project folder (or all-project ones when unfiled); a client signed in from
 * outside a thread gets the unrestricted owner view.
 */
const callerLabel = Effect.gen(function* () {
  const scope = yield* Invocation.McpInvocationContext;
  if (scope.thread === undefined) return undefined;
  const files = yield* Effect.serviceOption(ProjectFiles.ProjectFiles);
  if (Option.isNone(files)) return null;
  const folder = yield* files.value
    .folderForThread(scope.thread.threadId)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  return (folder?.labelId ?? null) as ProjectLabelId | null;
});

const byName = (name: string, fail: (cause: unknown) => OrchestratorMcpFailure) =>
  Effect.gen(function* () {
    const service = yield* Integrations.Integrations;
    const { integrations } = yield* service.list().pipe(Effect.mapError(fail));
    const label = yield* callerLabel;
    const found = integrations.find(
      (summary) =>
        summary.integration.name === name &&
        Integrations.integrationVisibleTo({ ...summary.integration, enabled: true }, label),
    );
    if (found === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "No connected integration with that name is available in this project.",
      });
    }
    return found.integration;
  });

const addedByAgent = (fail: (cause: unknown) => OrchestratorMcpFailure) =>
  Effect.gen(function* () {
    const scope = yield* Invocation.McpInvocationContext;
    if (scope.thread === undefined)
      return { id: scope.requestNamespace, name: scope.client?.label ?? "MCP agent" };
    const agents = yield* AgentStore.AgentStore;
    const agent = yield* agents.forThread(scope.thread.threadId).pipe(Effect.mapError(fail));
    return { id: agent?.id ?? scope.thread.threadId, name: agent?.name ?? "Coding agent" };
  });

/** Live runtime keeps the agent waiting on the durable inline card. */
const finishSetup = (
  scope: Invocation.McpInvocationScope,
  result: import("@cogenly/contracts").IntegrationConnectResult,
  accountLabel?: string,
) =>
  Effect.serviceOption(SetupRequests.IntegrationSetupRequests).pipe(
    Effect.flatMap((requests) =>
      Option.isSome(requests)
        ? requests.value.finish(scope, result, accountLabel)
        : Effect.succeed(result),
    ),
  );

export const layer = McpToolAccess.toLayer(IntegrationsToolkit, {
  integration_install_runtime: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      return yield* (yield* Integrations.Integrations)
        .installRuntime(input.runtime)
        .pipe(Effect.mapError(failure));
    }),
  ),
  integration_setup_guide: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      return yield* (yield* Integrations.Integrations).setupGuide(input.service);
    }),
  ),
  integration_test: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      const integration = yield* byName(input.name, failure);
      return yield* (yield* Integrations.Integrations)
        .testConnection(integration.id, yield* callerLabel)
        .pipe(Effect.mapError(failure));
    }),
  ),
  integrations_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const service = yield* Integrations.Integrations;
      const scope = yield* Invocation.McpInvocationContext;
      const label = yield* callerLabel;
      const { integrations } = yield* (
        label === undefined ? service.list() : service.listForProject(label)
      ).pipe(Effect.mapError(failure));
      return {
        integrations: integrations.map((summary) => agentSummary(summary)),
      };
    }),
  ),
  // Listing tools changes nothing, but it can send the integration's credentials
  // upstream, so it needs a caller that may call the integration.
  integration_tools: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const service = yield* Integrations.Integrations;
      const scope = yield* Invocation.McpInvocationContext;
      const label = yield* callerLabel;
      return yield* service.listTools(input.name, label).pipe(Effect.mapError(failure));
    }),
  ),
  integration_call: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const service = yield* Integrations.Integrations;
      const scope = yield* Invocation.McpInvocationContext;
      const label = yield* callerLabel;
      return yield* service
        .callTool(input.name, input.tool, input.arguments, label)
        .pipe(Effect.mapError(failure));
    }),
  ),
  // The result is the account plus its sign-in link, or the step that comes first.
  integration_add: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const service = yield* Integrations.Integrations;
      const scope = yield* Invocation.McpInvocationContext;
      const fail = failure;
      const context = { accountLabel: input.accountLabel };
      const decoded =
        input.catalogId === undefined
          ? yield* decodeAdd(input).pipe(
              Effect.mapError(
                () =>
                  new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message:
                      "Pass either catalogId for a default service, or a remote server (name, displayName, transport, url, headers, scope and hint).",
                  }),
              ),
            )
          : undefined;
      // The Google preset is the catalog entry, so it gets the same guided steps.
      const request =
        input.catalogId !== undefined
          ? catalogRequest({ ...input, catalogId: input.catalogId })
          : decoded !== undefined && "preset" in decoded
            ? catalogRequest({ ...input, catalogId: "google-workspace" })
            : undefined;
      if (request !== undefined) {
        const connected = yield* service
          .connectFromCatalog(request, {
            origin: { origin: scope.httpOrigin, fromAgent: true, threadId: scope.thread?.threadId },
            addedByAgent: yield* addedByAgent(fail),
            fromAgent: true,
          })
          .pipe(Effect.mapError(catalogFailure));
        return withAgentNextStep(yield* finishSetup(scope, connected, input.accountLabel), context);
      }
      if (decoded === undefined || "preset" in decoded)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Pass catalogId, or a remote server's name, url and headers.",
        });
      const { integration } = yield* service
        .create(decoded, { addedByAgent: yield* addedByAgent(fail), fromAgent: true })
        .pipe(
          Effect.catchTags({
            IntegrationError: (error) =>
              Effect.serviceOption(SetupRequests.IntegrationSetupRequests).pipe(
                Effect.flatMap((requests) =>
                  Option.isSome(requests)
                    ? requests.value.approveCreate(scope, decoded, error)
                    : Effect.fail(error),
                ),
              ),
          }),
          Effect.mapError((error) => (isIntegrationError(error) ? fail(error) : error)),
        );
      const prepared = yield* service
        .prepareSignIn(integration.id, {
          origin: scope.httpOrigin,
          fromAgent: true,
          callbackOrigin: input.callbackOrigin,
          threadId: scope.thread?.threadId,
        })
        .pipe(Effect.mapError(fail));
      return withAgentNextStep(yield* finishSetup(scope, prepared, input.accountLabel), context);
    }),
  ),
  integration_update: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const service = yield* Integrations.Integrations;
      const scope = yield* Invocation.McpInvocationContext;
      const fail = failure;
      const current = yield* byName(input.name, fail);
      const label = yield* callerLabel;
      const agents = yield* AgentStore.AgentStore;
      const agent =
        scope.thread === undefined
          ? null
          : yield* agents.forThread(scope.thread.threadId).pipe(Effect.mapError(fail));
      const { integration } = yield* service
        .update(
          {
            id: current.id,
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
            ...(input.url === undefined ? {} : { url: input.url }),
            ...(input.endpointRef === undefined ? {} : { endpointRef: input.endpointRef }),
            ...(input.transport === undefined ? {} : { transport: input.transport }),
            ...(input.headers === undefined ? {} : { headers: input.headers }),
            ...(input.command === undefined ? {} : { command: input.command }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.scope === undefined ? {} : { scope: input.scope }),
            ...(input.hint === undefined ? {} : { hint: input.hint }),
            ...(input.accountLabel === undefined ? {} : { accountLabel: input.accountLabel }),
            ...(input.auth === undefined ? {} : { auth: input.auth }),
            ...(input.setupNotes === undefined ? {} : { setupNotes: input.setupNotes }),
          },
          {
            preserveCredentialDestination: agent !== null,
            fromAgent: true,
            holdStoredSecrets: true,
            callerLabelId: label,
            preserveScope: agent !== null,
          },
        )
        .pipe(
          Effect.catchTags({
            IntegrationError: (error) =>
              Effect.serviceOption(SetupRequests.IntegrationSetupRequests).pipe(
                Effect.flatMap((requests) =>
                  Option.isSome(requests)
                    ? requests.value.approveUpdate(scope, current, input, error)
                    : Effect.fail(error),
                ),
              ),
          }),
          Effect.mapError((error) => (isIntegrationError(error) ? fail(error) : error)),
        );
      const prepared = yield* service
        .prepareSignIn(integration.id, {
          origin: scope.httpOrigin,
          fromAgent: true,
          callbackOrigin: input.callbackOrigin,
          threadId: scope.thread?.threadId,
        })
        .pipe(Effect.mapError(fail));
      return withAgentNextStep(yield* finishSetup(scope, prepared));
    }),
  ),
  integration_remove: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const service = yield* Integrations.Integrations;
      const scope = yield* Invocation.McpInvocationContext;
      const fail = failure;
      const current = yield* byName(input.name, fail).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (current === undefined) return { deleted: false };
      const label = yield* callerLabel;
      return yield* service
        .remove(current.id, { callerLabelId: label })
        .pipe(Effect.mapError(fail));
    }),
  ),
});

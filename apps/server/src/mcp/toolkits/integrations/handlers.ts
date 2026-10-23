import { IntegrationError, OrchestratorMcpFailure, type ProjectLabelId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Integrations from "../../../integrations/Integrations.ts";
import * as AgentStore from "../../../agents/AgentStore.ts";
import * as ProjectFiles from "../../../projectLabels/ProjectFiles.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import { IntegrationsToolkit } from "./tools.ts";

const isIntegrationError = Schema.is(IntegrationError);
const failure = (cause: unknown): OrchestratorMcpFailure =>
  isIntegrationError(cause)
    ? new OrchestratorMcpFailure({
        code:
          cause.reason === "not_found" ||
          cause.reason === "disabled" ||
          cause.reason === "credential_unresolved" ||
          cause.reason === "credential_not_allowed"
            ? "invalid_request"
            : "orchestration_error",
        message:
          cause.reason === "credential_unresolved"
            ? "An integration credential could not be resolved. Ask the owner to check the vault item named in its headers."
            : cause.reason === "credential_not_allowed"
              ? "A vault item in this integration's headers isn't allowed for its server. Ask the owner to add the server to the item's allowed domains, or to save the integration in Settings → Integrations to approve it."
              : cause.reason === "upstream_timeout"
                ? "The integration did not answer in time. Try again, or ask the owner to check it in Settings."
                : cause.reason === "upstream_unreachable"
                  ? "The integration could not be reached. Ask the owner to check it in Settings."
                  : cause.reason === "not_found"
                    ? "No connected integration with that name is available in this project."
                    : cause.reason === "disabled"
                      ? "That integration is disabled."
                      : cause.reason === "conflict"
                        ? "An integration with that name already exists."
                        : "The integration request could not be completed.",
      })
    : new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "The integration request could not be completed.",
      });

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

const byName = (name: string) =>
  Effect.gen(function* () {
    const service = yield* Integrations.Integrations;
    const { integrations } = yield* service.list().pipe(Effect.mapError(failure));
    const found = integrations.find((summary) => summary.integration.name === name);
    if (found === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "No connected integration with that name is available in this project.",
      });
    }
    return found.integration;
  });

export const layer = McpToolAccess.toLayer(IntegrationsToolkit, {
  integrations_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const service = yield* Integrations.Integrations;
      const label = yield* callerLabel;
      return yield* (label === undefined ? service.list() : service.listForProject(label)).pipe(
        Effect.mapError(failure),
      );
    }),
  ),
  integration_tools: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* Integrations.Integrations;
      const label = yield* callerLabel;
      return yield* service.listTools(input.name, label).pipe(Effect.mapError(failure));
    }),
  ),
  integration_call: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const service = yield* Integrations.Integrations;
      const label = yield* callerLabel;
      return yield* service
        .callTool(input.name, input.tool, input.arguments, label)
        .pipe(Effect.mapError(failure));
    }),
  ),
  integration_add: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const service = yield* Integrations.Integrations;
      return yield* service.create(input).pipe(Effect.mapError(failure));
    }),
  ),
  integration_update: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const service = yield* Integrations.Integrations;
      const current = yield* byName(input.name);
      const scope = yield* Invocation.McpInvocationContext;
      const agents = yield* AgentStore.AgentStore;
      const agent =
        scope.thread === undefined
          ? null
          : yield* agents.forThread(scope.thread.threadId).pipe(Effect.mapError(failure));
      return yield* service
        .update(
          {
            id: current.id,
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
            ...(input.url === undefined ? {} : { url: input.url }),
            ...(input.transport === undefined ? {} : { transport: input.transport }),
            ...(input.headers === undefined ? {} : { headers: input.headers }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.scope === undefined ? {} : { scope: input.scope }),
            ...(input.hint === undefined ? {} : { hint: input.hint }),
          },
          { preserveCredentialDestination: agent !== null },
        )
        .pipe(Effect.mapError(failure));
    }),
  ),
  integration_remove: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const service = yield* Integrations.Integrations;
      const current = yield* byName(input.name).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (current === undefined) return { deleted: false };
      return yield* service.remove(current.id).pipe(Effect.mapError(failure));
    }),
  ),
});

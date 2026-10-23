import {
  IntegrationAddInput,
  IntegrationError,
  OrchestratorMcpFailure,
  type Integration,
  type ProjectLabelId,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Integrations from "../../../integrations/Integrations.ts";
import * as AgentStore from "../../../agents/AgentStore.ts";
import * as ProjectFiles from "../../../projectLabels/ProjectFiles.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import { catalogRequest } from "../../../integrations/IntegrationCatalog.ts";
import { GOOGLE_CLIENT_HELP } from "../../../integrations/local/GoogleWorkspace.ts";
import { IntegrationsToolkit } from "./tools.ts";

const isIntegrationError = Schema.is(IntegrationError);
const decodeAdd = Schema.decodeUnknownEffect(IntegrationAddInput);

/** What an agent can act on, per reason; anything else is a server-side fault. */
const AGENT_MESSAGES: Partial<Record<IntegrationError["reason"], string>> = {
  approval_required:
    "This integration change needs owner approval: it widens access, or moves stored credentials to a new destination. Ask the owner to make it in Settings → Integrations.",
  sign_in_required:
    "This integration needs the user to sign in (again). Call integration_update with just its name to get a sign-in link, and give it to the user to open in their browser.",
  client_id_required:
    "This server does not register clients automatically. The user must create an OAuth app with the provider, store its client secret in the vault, and set auth.clientId and auth.clientSecret ({{credential:<item>.<field>}}), e.g. in Settings → Integrations.",
  credential_unresolved:
    "An integration credential could not be resolved. Ask the owner to check the vault item named in its headers or client secret.",
  credential_not_allowed:
    "A vault item in this integration's headers isn't allowed for its server. Ask the owner to add the server to the item's allowed domains, or to save the integration in Settings → Integrations to approve it.",
  not_found: "No connected integration with that name is available in this project.",
  disabled: "That integration is disabled.",
  google_client_missing: `Google needs the user's own OAuth client before an account can connect. Point the user to docs/user/integrations.md#connect-google to create one (a Web application client in Google Cloud). ${GOOGLE_CLIENT_HELP} Then call integration_add again.`,
  local_runtime_missing:
    "uvx is missing. Install uv with brew install uv (macOS) or https://docs.astral.sh/uv/getting-started/installation/ (Linux), then call integration_update with the saved account name to retry sign-in.",
};
const SERVER_MESSAGES: Partial<Record<IntegrationError["reason"], string>> = {
  upstream_timeout:
    "The integration did not answer in time. Try again, or ask the owner to check it in Settings.",
  upstream_unreachable:
    "The integration could not be reached. Ask the owner to check it in Settings.",
  conflict: "An integration with that name already exists.",
};

const failure = (cause: unknown): OrchestratorMcpFailure => {
  if (!isIntegrationError(cause))
    return new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: "The integration request could not be completed.",
    });
  const agentMessage = AGENT_MESSAGES[cause.reason];
  return new OrchestratorMcpFailure({
    code: agentMessage === undefined ? "orchestration_error" : "invalid_request",
    message:
      agentMessage ??
      SERVER_MESSAGES[cause.reason] ??
      "The integration request could not be completed.",
  });
};

/** A catalog request's next step (a region, a vault reference) is the agent's message. */
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

const byName = (name: string) =>
  Effect.gen(function* () {
    const service = yield* Integrations.Integrations;
    const { integrations } = yield* service.list().pipe(Effect.mapError(failure));
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

/**
 * The integration, plus a sign-in link when it signs in (remote OAuth or a
 * managed local account) and has no usable grant yet. A remote link returns
 * to the origin this MCP request reached; a local one to its callback origin.
 */
const withSignIn = (integration: Integration, callbackOrigin?: string) =>
  Effect.gen(function* () {
    if (integration.auth?.type !== "oauth" && integration.transport !== "local")
      return { integration };
    const service = yield* Integrations.Integrations;
    const { integrations } = yield* service.list().pipe(Effect.mapError(failure));
    const summary = integrations.find((entry) => entry.integration.id === integration.id);
    if (summary?.managed?.state === "missing_runtime")
      return yield* failure(
        new IntegrationError({
          operation: "connect local account",
          reason: "local_runtime_missing",
        }),
      );
    if (summary?.status !== "needs_sign_in") return { integration };
    const scope = yield* Invocation.McpInvocationContext;
    const signIn = yield* service
      .beginSignIn(integration.id, { origin: scope.httpOrigin, fromAgent: true, callbackOrigin })
      .pipe(
        Effect.mapError((cause) => {
          const reason = catalogFailure(cause).message;
          return new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `${integration.name} is saved, but sign-in could not start. ${reason}`,
          });
        }),
      );
    return { integration, signIn };
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
  // Listing tools changes nothing, but it can send the integration's credentials
  // upstream, so it needs a caller that may call the integration.
  integration_tools: McpToolAccess.writesWithCapability((input) =>
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
      const scope = yield* Invocation.McpInvocationContext;
      if (input.catalogId !== undefined) {
        const connected = yield* service
          .connectFromCatalog(catalogRequest({ ...input, catalogId: input.catalogId }), {
            origin: { origin: scope.httpOrigin, fromAgent: true },
          })
          .pipe(Effect.mapError(catalogFailure));
        // No link: its sign-in could not start, so ask again for the reason.
        return connected.signIn === undefined
          ? yield* withSignIn(connected.integration, input.callbackOrigin)
          : connected;
      }
      const decoded = yield* decodeAdd(input).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "Pass either a remote server (name, displayName, transport, url, headers, scope, hint) or a managed Google account (preset: google-workspace, accountLabel).",
            }),
        ),
      );
      const request =
        "preset" in decoded &&
        decoded.callbackOrigin === undefined &&
        scope.httpOrigin &&
        !isLoopbackHost(new URL(scope.httpOrigin).hostname)
          ? { ...decoded, callbackOrigin: scope.httpOrigin }
          : decoded;
      const { integration } = yield* service.create(request).pipe(Effect.mapError(failure));
      return yield* withSignIn(integration, input.callbackOrigin);
    }),
  ),
  integration_update: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const service = yield* Integrations.Integrations;
      const current = yield* byName(input.name);
      const label = yield* callerLabel;
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
            ...(input.accountLabel === undefined ? {} : { accountLabel: input.accountLabel }),
            ...(input.auth === undefined ? {} : { auth: input.auth }),
          },
          {
            preserveCredentialDestination: agent !== null,
            // An agent never moves a stored token or vault credential to a new destination;
            // the owner makes that change in Settings.
            holdStoredSecrets: true,
            callerLabelId: label,
            preserveScope: true,
          },
        )
        .pipe(
          Effect.mapError(failure),
          Effect.flatMap(({ integration }) => withSignIn(integration, input.callbackOrigin)),
        );
    }),
  ),
  integration_remove: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const service = yield* Integrations.Integrations;
      const current = yield* byName(input.name).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (current === undefined) return { deleted: false };
      const label = yield* callerLabel;
      return yield* service
        .remove(current.id, { callerLabelId: label })
        .pipe(Effect.mapError(failure));
    }),
  ),
});

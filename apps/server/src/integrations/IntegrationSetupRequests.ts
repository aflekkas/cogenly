import {
  CommandId,
  MessageId,
  ThreadId,
  type IntegrationSummary,
  type IntegrationListResult,
  TurnItemId,
  OrchestratorMcpFailure,
  integrationCatalogEntryFor,
  IntegrationError,
  type Integration,
  type IntegrationUpdateByNameInput,
  type IntegrationCreateInput,
  type IntegrationMutationResult,
  type IntegrationConnectResult,
  type IntegrationId,
  type AgentApprovalAction,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as SqlClient from "effect/sql/SqlClient";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Workspace from "../agents/AgentWorkspaceService.ts";
import * as ApprovalChanges from "../agents/ApprovalChanges.ts";
import * as Integrations from "./Integrations.ts";

const failed = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "Integration setup ended without connecting. The inline card shows the next step.",
  });

/** Keeps setup attached to its calling turn. Only the owner-facing RPC can change settings or start consent. */
export class IntegrationSetupRequests extends Context.Service<
  IntegrationSetupRequests,
  {
    readonly finish: (
      scope: McpInvocationScope,
      result: IntegrationConnectResult,
      accountLabel?: string,
    ) => Effect.Effect<IntegrationConnectResult, OrchestratorMcpFailure>;
    readonly approve: (
      scope: McpInvocationScope,
      action: Extract<
        AgentApprovalAction,
        { actionKind: "integration_add" | "integration_update" }
      >,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly waitForApproval: (id: string) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly approveUpdate: (
      scope: McpInvocationScope,
      current: Integration,
      input: IntegrationUpdateByNameInput,
      error: IntegrationError,
    ) => Effect.Effect<IntegrationMutationResult, IntegrationError | OrchestratorMcpFailure>;
    readonly approveCreate: (
      scope: McpInvocationScope,
      input: IntegrationCreateInput,
      error: IntegrationError,
    ) => Effect.Effect<IntegrationMutationResult, IntegrationError | OrchestratorMcpFailure>;
    readonly resume: (
      scope: McpInvocationScope,
      id: IntegrationId,
    ) => Effect.Effect<IntegrationConnectResult, OrchestratorMcpFailure>;
  }
>()("cogenly-server/integrations/IntegrationSetupRequests") {}

const make = Effect.gen(function* () {
  const threads = yield* Threads.ThreadManagementService;
  const integrations = yield* Integrations.Integrations;
  const workspace = yield* Workspace.AgentWorkspaceService;
  const changes = yield* ApprovalChanges.ApprovalChanges;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const waitingCalls = new Map<string, Deferred.Deferred<boolean>>();

  /** A callback can arrive after the provider's tool timeout or after a server restart. */
  const completeCards = (list: IntegrationListResult) =>
    Effect.gen(function* () {
      const pending = yield* sql<{
        thread_id: string;
      }>`SELECT DISTINCT thread_id FROM orchestration_v2_projection_turn_items WHERE type = 'secret_request' AND json_extract(payload_json, '$.secretStatus') = 'pending' AND json_type(payload_json, '$.integrationSetup') = 'object'`;
      for (const row of pending) {
        const threadId = ThreadId.make(row.thread_id);
        const records = yield* threads.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        });
        if (records.thread.deletedAt !== null || records.thread.archivedAt !== null) continue;
        for (const item of records.turnItems) {
          if (
            item.type !== "secret_request" ||
            item.secretStatus !== "pending" ||
            !item.integrationSetup ||
            !item.runId ||
            !item.nodeId
          )
            continue;
          const target = item.integrationSetup;
          const connected = list.integrations.find(
            (summary) =>
              summary.status === "connected" &&
              (target.integrationId
                ? summary.integration.id === target.integrationId
                : integrationCatalogEntryFor(summary.integration)?.id === target.setup?.catalogId &&
                  summary.integration.accountLabel === target.accountLabel),
          );
          if (!connected) continue;
          const waiting = waitingCalls.get(item.id);
          if (waiting === undefined || !(yield* Deferred.await(waiting))) {
            yield* threads.sendToThread({
              projectId: records.thread.projectId,
              threadId,
              commandId: CommandId.make(`integration-connected:${item.id}`),
              messageId: MessageId.make(`message:integration-connected:${item.id}`),
              text: `${connected.integration.displayName} (${connected.integration.name}) is connected. Continue the integration setup request: run integration_test and list its tools.`,
              attachments: [],
              mode: "auto",
              createdBy: "system",
              creationSource: "server",
            });
          }
          yield* threads.dispatch({
            type: "secret_request.record",
            commandId: CommandId.make(`${item.id}:saved`),
            threadId,
            runId: item.runId,
            nodeId: item.nodeId,
            turnItemId: item.id,
            label: item.label,
            reason: item.reason,
            integrationSetup: target,
            secretStatus: "saved",
          });
        }
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not complete inline integration setup", { errorTag: error._tag }),
      ),
    );

  yield* integrations.subscribe().pipe(Stream.runForEach(completeCards), Effect.forkScoped);

  const waitForApproval = (id: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const changed = yield* changes.subscribe;
        const approval = yield* Stream.concat(Stream.succeed(undefined), changed).pipe(
          Stream.mapEffect(() => workspace.listApprovals({})),
          Stream.map(({ approvals }) => approvals.find((approval) => approval.id === id)),
          Stream.filter((approval) => approval !== undefined && approval.status !== "pending"),
          Stream.runHead,
        );
        if (Option.isNone(approval) || approval.value?.status !== "approved")
          return yield* failed();
      }),
    ).pipe(
      Effect.timeout("15 minutes"),
      Effect.mapError(() => failed()),
    );

  const finish: IntegrationSetupRequests["Service"]["finish"] = (scope, result, accountLabel) =>
    Effect.gen(function* () {
      if (scope.thread === undefined || (!result.integration && !result.setup?.catalogId))
        return result;
      const matches = (summary: import("@cogenly/contracts").IntegrationSummary) =>
        result.integration
          ? summary.integration.id === result.integration.id
          : integrationCatalogEntryFor(summary.integration)?.id === result.setup?.catalogId &&
            summary.integration.accountLabel === accountLabel;
      const current = (yield* integrations.list()).integrations.find(matches);
      if (current?.status === "connected") return result;
      const threadId = scope.thread.threadId;
      const records = yield* threads.getThreadRecords(threadId, ["runs"]);
      const run = records.runs.find(
        (run) =>
          !Threads.isTerminalRunStatus(run.status) &&
          run.providerInstanceId === scope.thread!.providerInstanceId,
      );
      if (!run || !run.rootNodeId) return yield* failed();
      const key = yield* crypto.randomUUIDv4();
      const turnItemId = TurnItemId.make(`turn-item:integration-setup:${key}`);
      const integration = result.integration;
      const record = (secretStatus: "pending" | "saved" | "cancelled") =>
        threads.dispatch({
          type: "secret_request.record",
          commandId: CommandId.make(`${turnItemId}:${secretStatus}`),
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId!,
          turnItemId,
          label: integration ? `Connect ${integration.displayName}` : result.setup!.title,
          reason: "Complete integration setup here. The agent will continue when it connects.",
          integrationSetup: {
            ...(integration ? { integrationId: integration.id } : {}),
            ...(result.setup ? { setup: result.setup } : {}),
            ...(accountLabel ? { accountLabel } : {}),
          },
          secretStatus,
        });
      const delivered = yield* Deferred.make<boolean>();
      waitingCalls.set(turnItemId, delivered);
      return yield* Effect.gen(function* () {
        yield* record("pending");
        const connected = yield* integrations.subscribe().pipe(
          Stream.map((list) => list.integrations.find(matches)),
          Stream.filter(
            (summary): summary is IntegrationSummary => summary?.status === "connected",
          ),
          Stream.runHead,
          Effect.timeoutOption("45 seconds"),
          Effect.map(Option.flatten),
        );
        // Consent belongs to the card, not the lifetime of this MCP request.
        if (Option.isNone(connected)) return { ...result, signIn: undefined };
        yield* record("saved");
        yield* Deferred.succeed(delivered, true);
        return { ...connected.value, signIn: undefined };
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Deferred.succeed(delivered, false);
            waitingCalls.delete(turnItemId);
          }),
        ),
      );
    }).pipe(Effect.mapError(() => failed()));

  const resume = (scope: McpInvocationScope, id: IntegrationId) =>
    integrations
      .prepareSignIn(id, {
        origin: scope.httpOrigin,
        fromAgent: true,
      })
      .pipe(
        Effect.mapError(() => failed()),
        Effect.flatMap((result) => finish(scope, result)),
      );

  const approve: IntegrationSetupRequests["Service"]["approve"] = (scope, action) =>
    scope.thread === undefined
      ? Effect.fail(failed())
      : workspace.requestThreadIntegrationApproval(scope.thread.threadId, action).pipe(
          Effect.mapError(() => failed()),
          Effect.flatMap(({ approval }) => waitForApproval(approval.id)),
        );
  const approvedIntegration = (matches: (integration: Integration) => boolean) =>
    integrations.list().pipe(
      Effect.flatMap(({ integrations }) => {
        const integration = integrations.find((summary) =>
          matches(summary.integration),
        )?.integration;
        return integration ? Effect.succeed({ integration }) : Effect.fail(failed());
      }),
    );
  return IntegrationSetupRequests.of({
    finish,
    waitForApproval,
    resume,
    approve,
    approveUpdate: (scope, current, input, error) =>
      Effect.gen(function* () {
        if (error.reason !== "approval_required") return yield* error;
        yield* approve(scope, {
          actionKind: "integration_update",
          payload: {
            ...input,
            id: current.id,
            url: input.url ?? current.url,
            transport: input.transport ?? current.transport,
            headers: input.headers ?? current.headers,
          },
        });
        return yield* approvedIntegration((integration) => integration.id === current.id);
      }),
    approveCreate: (scope, input, error) =>
      Effect.gen(function* () {
        if (error.reason !== "approval_required") return yield* error;
        yield* approve(scope, { actionKind: "integration_add", payload: input });
        return yield* approvedIntegration((integration) => integration.name === input.name);
      }),
  });
});
export const layer = Layer.effect(IntegrationSetupRequests, make);

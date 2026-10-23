import * as Access from "./AgentAccessScope.ts";
import {
  AgentStartWorkInput,
  WorkStartInput,
  AgentApprovalAction,
  OrchestratorMcpFailure,
  OrchestratorMcpScheduleTaskInput,
  IntegrationCreateInput,
  type AgentPermissions,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./AgentStore.ts";
import * as Workspace from "./AgentWorkspaceService.ts";
import { McpInvocationContext, type McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { readCaller, assertLiveCaller } from "../mcp/threadAccess.ts";
import { resolveRuntimeMode } from "../mcp/OrchestratorMcpService.ts";

const decodeWorkStart = Schema.decodeUnknownEffect(WorkStartInput);
const decodeStartWork = Schema.decodeUnknownEffect(AgentStartWorkInput);
const decodeSchedule = Schema.decodeUnknownEffect(OrchestratorMcpScheduleTaskInput);
const decodeIntegrationAdd = Schema.decodeUnknownEffect(IntegrationCreateInput);
const decodeAction = Schema.decodeUnknownEffect(AgentApprovalAction);
const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const denied = (
  message: string,
  code: OrchestratorMcpFailure["code"] = "agent_permission_denied",
) => new OrchestratorMcpFailure({ code, message });
const inputRecord = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown));
/** Enforced at the authenticated HTTP boundary, before any toolkit handler. */
export class AgentMcpPolicy extends Context.Service<
  AgentMcpPolicy,
  {
    readonly beforeTool: (
      scope: McpInvocationScope,
      name: string,
      input: unknown,
      readonly: boolean,
    ) => Effect.Effect<{ handled: boolean; result?: unknown }, OrchestratorMcpFailure>;
    readonly afterTool: (
      scope: McpInvocationScope,
      name: string,
      readonly: boolean,
      result?: unknown,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
  }
>()("t3/agents/AgentMcpPolicy") {}
const make = Effect.gen(function* () {
  const store = yield* Store.AgentStore;
  const workspace = yield* Workspace.AgentWorkspaceService;
  const sql = yield* SqlClient.SqlClient;
  const access = yield* Access.AgentAccessScope;
  const threads = yield* Threads.ThreadManagementService;
  const actorFor = (scope: McpInvocationScope) =>
    scope.thread === undefined
      ? Effect.succeed(null)
      : store
          .forThread(scope.thread.threadId)
          .pipe(
            Effect.map((agent) => (agent ? { agent, threadId: scope.thread!.threadId } : null)),
          );
  return AgentMcpPolicy.of({
    beforeTool: (scope, name, input, readonly) =>
      Effect.gen(function* () {
        // Builder threads belong to no agent, so they fall through the actor
        // check below; the proposal tool is gated on the thread surface here.
        if (name === "propose_agent") {
          if (scope.thread === undefined)
            return yield* denied("propose_agent needs a builder thread.", "invalid_request");
          const shell = yield* threads.getThreadShell(scope.thread.threadId);
          if (shell?.surface !== "builder")
            return yield* denied("propose_agent only runs in a builder thread.", "invalid_request");
          return { handled: false };
        }
        const actor = yield* actorFor(scope);
        if (!actor) return { handled: false };
        const resolved = yield* access.resolve(actor.agent.id);
        const { agent } = resolved;
        const params = yield* inputRecord(input ?? {});
        if (!agent.permissions.read) return yield* denied("This agent has no read grant.");
        const permittedProject = (id: unknown) =>
          resolved.readableRepositoryIds.some((repositoryId) => repositoryId === id);
        if (
          params.projectId !== undefined &&
          !permittedProject(params.projectId) &&
          !["request_agent_approval", "t3_thread_launch", "start_agent_work"].includes(name)
        )
          return yield* denied("This repository does not exist in this environment.");
        if (typeof params.threadId === "string" && params.threadId !== actor.threadId) {
          const rows = yield* sql<{
            project_id: string;
          }>`SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id = ${params.threadId}`;
          if (!permittedProject(rows[0]?.project_id))
            return yield* denied("This thread is not in a live repository.");
        }
        if (readonly) return { handled: false };
        if (["create_threads", "delegate_task", "t3_thread_fork"].includes(name))
          return yield* denied(
            "Persistent agents must start governed Work with start_agent_work; untracked child threads require the owner.",
          );
        if (name === "start_agent_builder")
          return yield* denied(
            "Persistent agents cannot start agent builders; only the owner creates agents.",
          );
        if (name === "update_agent_project" && params.id !== agent.id)
          return yield* denied(
            "An agent can only move its own conversation between projects. Ask the owner to move other agents.",
          );
        if (typeof params.threadId === "string" && params.threadId !== actor.threadId) {
          const targetAgent = yield* store.forThread(params.threadId as typeof actor.threadId);
          if (targetAgent?.id !== agent.id)
            return yield* denied(
              "An agent cannot control another principal's thread. Propose a bounded Work session.",
            );
        }
        const caller = yield* readCaller().pipe(
          Effect.tap(assertLiveCaller),
          Effect.provideService(McpInvocationContext, scope),
          Effect.provideService(Threads.ThreadManagementService, threads),
        );
        yield* resolveRuntimeMode(caller.limits.runtimeMode, agent.runtimeMode);
        if (
          [
            "t3_pending_request_respond",
            "t3_thread_configure",
            "t3_environment_preferences_update",
          ].includes(name)
        )
          return yield* denied(
            "An agent cannot approve its own requests or change its authority. Ask the owner.",
          );
        // These tools implement their own finer draft/label rules and never grant authority.
        if (
          [
            "request_agent_approval",
            "propose_trigger",
            "propose_event_trigger",
            "propose_commitment",
            "update_commitment_status",
          ].includes(name)
        )
          return { handled: false };
        if (name === "t3_thread_launch" || name === "work_start") {
          if (
            params.modelSelection !== undefined ||
            params.runtimeMode !== undefined ||
            params.interactionMode !== undefined
          )
            return yield* denied(
              "Persistent agent Work uses the model picked in the agent's chat and its configured modes. Use start_agent_work or ask the owner to switch models.",
              "invalid_request",
            );
          if (
            params.scratch === true ||
            (Array.isArray(params.attachments) && params.attachments.length > 0)
          )
            return yield* denied(
              "Persistent agents start repository Work through start_agent_work; scratch and uploads need the owner.",
            );
          const isWorkStart = name === "work_start";
          if (isWorkStart)
            yield* decodeWorkStart({
              ...params,
              sourceThreadId: actor.threadId,
            });
          const work = yield* decodeStartWork({
            ...(isWorkStart
              ? {
                  commandId: `work:${scope.requestNamespace}:${params.commandId}`,
                  sourceThreadId: actor.threadId,
                }
              : {}),
            agentId: agent.id,
            projectId: (isWorkStart ? params.targetProjectId : params.projectId) ?? agent.projectId,
            title: params.title,
            prompt: isWorkStart ? params.scopeSummary : (params.message ?? params.title),
            workspaceStrategy: isWorkStart
              ? params.workspace === "local"
                ? { type: "root" }
                : { type: "worktree", baseRef: "HEAD" }
              : params.workspaceStrategy,
          });
          const result = yield* workspace.startWork(work, actor);
          if (result.approval)
            return yield* denied(
              `Owner approval required: ${result.approval.id}`,
              "agent_approval_required",
            );
          return {
            handled: true,
            result: isWorkStart
              ? { threadId: result.threadId }
              : {
                  threadId: result.threadId,
                  projectId: work.projectId,
                  modelSelection: agent.modelSelection,
                  runId: null,
                  status: null,
                },
          };
        }
        if (name === "start_agent_work") return { handled: false };
        // Connecting an integration hands every agent a new credentialed
        // upstream, so a persistent agent proposes it and the owner approves
        // (approving creates it). The owner's own turns are not agents here:
        // actor is null for them and they fall through to the tool.
        if (name === "integration_add") {
          const payload = yield* decodeIntegrationAdd(input);
          const action = yield* decodeAction({
            actionKind: "integration_add",
            payload,
          });
          const { approval } = yield* workspace.requestApproval(agent.id, action, actor);
          return yield* denied(
            `Integration proposal awaiting owner approval: ${approval.id}`,
            "agent_approval_required",
          );
        }
        if (name === "schedule_task") {
          const schedule = yield* decodeSchedule(input);
          const action = yield* decodeAction({
            actionKind: "schedule_trigger",
            payload: {
              ...schedule,
              title: schedule.title ?? agent.name,
              agentId: agent.id,
              projectId: schedule.projectId ?? agent.projectId,
              threadId: agent.conversationThreadId,
              enabled: schedule.enabled ?? true,
              modelSelection: agent.modelSelection,
              runtimeMode: agent.runtimeMode,
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
            },
          });
          const { approval } = yield* workspace.requestApproval(agent.id, action, actor);
          return yield* denied(
            `Trigger proposal awaiting owner approval: ${approval.id}`,
            "agent_approval_required",
          );
        }
        if (
          ["update_scheduled_task", "delete_scheduled_task", "run_scheduled_task_now"].includes(
            name,
          )
        )
          return yield* denied(
            "Trigger changes require request_agent_approval and an owner decision.",
          );
        const targetRepository = params.projectId ?? params.targetProjectId;
        if (
          targetRepository !== undefined &&
          !resolved.executableRepositoryIds.some((id) => id === targetRepository)
        )
          return yield* denied("This agent has no execute grant.");
        const grant: keyof AgentPermissions = /merge/.test(name)
          ? "merge"
          : /deploy/.test(name)
            ? "deploy"
            : /delete|remove|forget/.test(name)
              ? "delete"
              : /create.*(?:pr|pull_request)/.test(name)
                ? "create_pr"
                : /send|comment|review|reply|reaction/.test(name) &&
                    !["t3_thread_send", "t3_thread_send_attachments"].includes(name)
                  ? "send"
                  : /fact_(propose|supersede)|memory_(remember|write)|html_|attachment_/.test(name)
                    ? "draft"
                    : "execute";
        if (!agent.permissions[grant]) return yield* denied(`This agent has no ${grant} grant.`);
        // Arbitrary shell/browser/device writes can send, merge, deploy or delete.
        // They cannot safely be reduced to an execute grant by parsing model text.
        // Adding a project (create or clone) is ordinary execute work for an agent.
        if (
          /^(terminal_|preview_|device_|t3_project_(?:update|delete))/.test(name) &&
          !["send", "create_pr", "merge", "deploy", "delete"].every(
            (key) => agent.permissions[key as keyof AgentPermissions],
          )
        )
          return yield* denied(
            "Unrestricted tool writes require all sensitive grants; use a bounded service action instead.",
          );
        return { handled: false };
      }).pipe(
        Effect.mapError((cause) =>
          isMcpFailure(cause)
            ? cause
            : denied("Could not authorize this agent action.", "agent_policy_unavailable"),
        ),
      ),
    afterTool: (scope, name, readonly, result) =>
      Effect.gen(function* () {
        if (
          readonly ||
          [
            "request_agent_approval",
            "propose_trigger",
            "propose_event_trigger",
            "propose_commitment",
            "update_commitment_status",
            "start_agent_work",
            "t3_thread_launch",
            "work_start",
          ].includes(name)
        )
          return;
        const actor = yield* actorFor(scope);
        if (!actor) return;
        const value = isRecord(result) ? result : {};
        if (value.deleted === false || value.changed === false || value.available === false) return;
        const target = [
          value.threadId,
          value.id,
          value.note && isRecord(value.note) ? value.note.id : undefined,
        ].find((id): id is string => typeof id === "string");
        yield* workspace.logAction(actor, `mcp:${name}`, target);
      }).pipe(
        Effect.mapError(() =>
          denied("Could not record the agent action.", "agent_audit_unavailable"),
        ),
      ),
  });
});
export const layer = Layer.effect(AgentMcpPolicy, make).pipe(Layer.provide(Access.layer));

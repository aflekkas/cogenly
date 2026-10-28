import {
  AgentApprovalAction,
  AgentMutationResult,
  AgentOwnProfileUpdateInput,
  ScheduledTaskEventSchedule,
  ScheduledTaskUpsertInput,
  ScheduledTaskUpsertSchedule,
  AgentApprovalResult,
  AgentStartWorkInput,
  AgentStartWorkResult,
  CommitmentCreateInput,
  CommitmentListInput,
  CommitmentListResult,
  CommitmentResult,
  CommitmentStatusInput,
  OrchestratorMcpFailure,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as Access from "../mcp/McpToolAccess.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Service from "./AgentService.ts";
import * as Store from "./AgentStore.ts";
import * as Workspace from "./AgentWorkspaceService.ts";
import { callingAgent } from "./MemoryMcp.ts";
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Service.AgentService,
    Workspace.AgentWorkspaceService,
    Store.AgentStore,
    Invocation.McpInvocationContext,
    Threads.ThreadManagementService,
  ],
};
const List = Tool.make("list_open_items", {
  ...shared,
  description: "Read shared commitments in every project, plus your own items.",
  parameters: Schema.Struct({
    status: CommitmentListInput.fields.status,
    labelId: CommitmentListInput.fields.labelId,
  }),
  success: CommitmentListResult,
}).annotate(Tool.Readonly, true);
const { agentId: _agentId, ...createFields } = CommitmentCreateInput.fields;
const Propose = Tool.make("propose_commitment", {
  ...shared,
  description:
    "Propose an extracted obligation with typed source and evidence references. It stays proposed until the owner confirms it.",
  parameters: Schema.Struct(createFields),
  success: CommitmentResult,
});
const Update = Tool.make("update_commitment_status", {
  ...shared,
  description:
    "Update an accessible commitment. Completion requires evidence; proposed obligations need owner confirmation before becoming open.",
  parameters: CommitmentStatusInput,
  success: CommitmentResult,
});
const Approval = Tool.make("request_agent_approval", {
  ...shared,
  description:
    "Propose Work, a trigger, or permission changes for the owner to approve or reject. This never grants authority to yourself.",
  parameters: Schema.Struct({ action: AgentApprovalAction }),
  success: AgentApprovalResult,
});
const { agentId: _startAgentId, ...workFields } = AgentStartWorkInput.fields;
const Work = Tool.make("start_agent_work", {
  ...shared,
  description:
    "Start a normal Work session in any repository with your execute grant, or return a pending owner approval without it.",
  parameters: Schema.Struct(workFields),
  success: AgentStartWorkResult,
});
const Trigger = Tool.make("propose_trigger", {
  ...shared,
  description:
    "Propose own-agent interval/time/event/webhook trigger for owner approval; never creates/enables directly.",
  parameters: Schema.Struct({
    title: ScheduledTaskUpsertInput.fields.title,
    prompt: ScheduledTaskUpsertInput.fields.prompt,
    schedule: ScheduledTaskUpsertSchedule,
  }),
  success: AgentApprovalResult,
});
const EventTrigger = Tool.make("propose_event_trigger", {
  ...shared,
  description:
    "Alias of propose_trigger for own-agent event proposals. Requires owner approval; never creates/enables directly.",
  parameters: Schema.Struct({
    title: ScheduledTaskUpsertInput.fields.title,
    prompt: ScheduledTaskUpsertInput.fields.prompt,
    schedule: ScheduledTaskEventSchedule,
  }),
  success: AgentApprovalResult,
});
const UpdateProfile = Tool.make("update_own_profile", {
  ...shared,
  description:
    "Immediately patch own name/face/responsibility/instructions/model/fallbackChain. Fallbacks are explicit cross-provider instance/model pairs for usage-limit/sign-out; same-provider accounts skipped.",
  parameters: AgentOwnProfileUpdateInput,
  success: AgentMutationResult,
});
export const toolkit = Toolkit.make(
  List,
  Propose,
  Update,
  Approval,
  Work,
  Trigger,
  EventTrigger,
  UpdateProfile,
);
const hasMessage = Schema.is(Schema.Struct({ message: Schema.String }));
const unavailable = (cause: unknown) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: hasMessage(cause) ? cause.message : "Could not access agent workspace state.",
  });
const proposeTrigger = (input: {
  readonly title: ScheduledTaskUpsertInput["title"];
  readonly prompt: ScheduledTaskUpsertInput["prompt"];
  readonly schedule: ScheduledTaskUpsertSchedule;
}) =>
  Effect.gen(function* () {
    const actor = yield* callingAgent;
    const agent = actor.agent;
    if (agent.projectId === null)
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "Choose an agent repository before proposing a trigger.",
      });
    return yield* (yield* Workspace.AgentWorkspaceService).requestApproval(
      agent.id,
      {
        actionKind: "schedule_trigger",
        payload: {
          ...input,
          agentId: agent.id,
          enabled: true,
          projectId: agent.projectId,
          threadId: agent.conversationThreadId,
          modelSelection: agent.modelSelection,
          runtimeMode: agent.runtimeMode,
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        },
      },
      actor,
    );
  }).pipe(Effect.mapError(unavailable));
export const handlers = Access.toLayer(toolkit, {
  list_open_items: Access.readsAsCaller((input) =>
    Effect.gen(function* () {
      const actor = yield* callingAgent;
      const workspace = yield* Workspace.AgentWorkspaceService;
      return yield* workspace.listOpenItems(input, actor);
    }).pipe(Effect.mapError(unavailable)),
  ),
  propose_commitment: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const actor = yield* callingAgent;
      return yield* (yield* Workspace.AgentWorkspaceService).createCommitment(
        { ...input, agentId: actor.agent.id },
        actor,
      );
    }).pipe(Effect.mapError(unavailable)),
  ),
  update_commitment_status: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const actor = yield* callingAgent;
      return yield* (yield* Workspace.AgentWorkspaceService).updateCommitmentStatus(input, actor);
    }).pipe(Effect.mapError(unavailable)),
  ),
  request_agent_approval: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const actor = yield* callingAgent;
      return yield* (yield* Workspace.AgentWorkspaceService).requestApproval(
        actor.agent.id,
        input.action,
        actor,
      );
    }).pipe(Effect.mapError(unavailable)),
  ),
  propose_trigger: Access.actsAsCaller(proposeTrigger),
  propose_event_trigger: Access.actsAsCaller(proposeTrigger),
  update_own_profile: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const actor = yield* callingAgent;
      const agent = actor.agent;
      const face = input.avatar;
      return yield* (yield* Service.AgentService).upsert({
        ...agent,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(face === undefined
          ? {}
          : { avatar: { ...agent.avatar, ...face, seed: face.seed ?? agent.avatar.seed } }),
        ...(input.responsibility === undefined ? {} : { responsibility: input.responsibility }),
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        ...(input.fallbackChain === undefined ? {} : { fallbackChain: input.fallbackChain }),
      });
    }).pipe(Effect.mapError(unavailable)),
  ),
  start_agent_work: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const actor = yield* callingAgent;
      return yield* (yield* Workspace.AgentWorkspaceService).startWork(
        { ...input, agentId: actor.agent.id },
        actor,
      );
    }).pipe(Effect.mapError(unavailable)),
  ),
});

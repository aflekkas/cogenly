import { ProjectLabelId } from "./projectLabel.ts";
import * as Schema from "effect/Schema";
import { AgentId, AgentPermissions, AgentScope, AgentAutonomy } from "./agent.ts";
import {
  CommandId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ScheduledTaskUpsertInput } from "./scheduledTask.ts";
import { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "./orchestrationV2.ts";

export const AgentStartWorkInput = Schema.Struct({
  agentId: AgentId,
  commandId: Schema.optional(CommandId),
  sourceThreadId: Schema.optional(ThreadId),
  projectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(32000)),
  workspaceStrategy: Schema.optional(OrchestrationV2ThreadLaunchWorkspaceStrategy),
});
export type AgentStartWorkInput = typeof AgentStartWorkInput.Type;
export const AgentApprovalAction = Schema.Union([
  Schema.Struct({ actionKind: Schema.Literal("start_work"), payload: AgentStartWorkInput }),
  Schema.Struct({
    actionKind: Schema.Literal("schedule_trigger"),
    payload: ScheduledTaskUpsertInput,
  }),
  Schema.Struct({
    actionKind: Schema.Literal("change_permissions"),
    payload: Schema.Struct({
      permissions: AgentPermissions,
      scope: Schema.optional(AgentScope),
      autonomy: Schema.optional(AgentAutonomy),
    }),
  }),
]);
export type AgentApprovalAction = typeof AgentApprovalAction.Type;
export const AgentApprovalStatus = Schema.Literals(["pending", "approved", "rejected", "expired"]);
export const AgentApproval = Schema.Struct({
  id: TrimmedNonEmptyString,
  agentId: AgentId,
  action: AgentApprovalAction,
  actionKind: Schema.Literals(["start_work", "schedule_trigger", "change_permissions"]),
  payload: Schema.Record(Schema.String, Schema.Unknown),
  status: AgentApprovalStatus,
  requestedAt: IsoDateTime,
  decidedAt: Schema.NullOr(IsoDateTime),
  decidedBy: Schema.NullOr(Schema.String),
  sourceRunId: Schema.NullOr(TrimmedNonEmptyString),
  resultThreadId: Schema.NullOr(ThreadId),
});
export type AgentApproval = typeof AgentApproval.Type;
export const AgentApprovalRequestInput = Schema.Struct({
  agentId: AgentId,
  action: AgentApprovalAction,
});
export const AgentApprovalListInput = Schema.Struct({
  agentId: Schema.optional(AgentId),
  status: Schema.optional(AgentApprovalStatus),
});
export const AgentApprovalListResult = Schema.Struct({ approvals: Schema.Array(AgentApproval) });
export const AgentApprovalKey = Schema.Struct({ id: TrimmedNonEmptyString });
export const AgentApprovalResult = Schema.Struct({ approval: AgentApproval });
export const AgentStartWorkResult = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
  approval: Schema.NullOr(AgentApproval),
});

export const CommitmentRef = Schema.Struct({
  kind: Schema.Literals(["thread", "message", "run", "pr", "url"]),
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
});
export type CommitmentRef = typeof CommitmentRef.Type;
export const CommitmentStatus = Schema.Literals([
  "proposed",
  "open",
  "in_progress",
  "waiting",
  "done",
  "dismissed",
]);
export const CommitmentOwner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({ kind: Schema.Literal("agent"), agentId: AgentId }),
  Schema.Struct({ kind: Schema.Literal("person"), name: TrimmedNonEmptyString }),
]);
const CommitmentFields = {
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  description: Schema.String.check(Schema.isMaxLength(16000)),
  owner: CommitmentOwner,
  dueAt: Schema.NullOr(IsoDateTime),
  reminderAt: Schema.NullOr(IsoDateTime),
  waitingOn: Schema.NullOr(Schema.String),
  labelIds: Schema.Array(ProjectLabelId),
  agentId: Schema.NullOr(AgentId),
  sourceRefs: Schema.Array(CommitmentRef),
  evidenceRefs: Schema.Array(CommitmentRef),
};
export const CommitmentCreateInput = Schema.Struct(CommitmentFields);
export type CommitmentCreateInput = typeof CommitmentCreateInput.Type;
export const Commitment = Schema.Struct({
  id: TrimmedNonEmptyString,
  ...CommitmentFields,
  status: CommitmentStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Commitment = typeof Commitment.Type;
/** agentId selects that agent's own items plus its explicitly authorized shared labels. */
export const CommitmentListInput = Schema.Struct({
  agentId: Schema.optional(AgentId),
  labelId: Schema.optional(ProjectLabelId),
  status: Schema.optional(CommitmentStatus),
});
export type CommitmentListInput = typeof CommitmentListInput.Type;
export const CommitmentListResult = Schema.Struct({ commitments: Schema.Array(Commitment) });
export const CommitmentResult = Schema.Struct({ commitment: Commitment });
export const CommitmentStatusInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  status: CommitmentStatus,
  why: TrimmedNonEmptyString,
  evidenceRefs: Schema.Array(CommitmentRef),
});
export type CommitmentStatusInput = typeof CommitmentStatusInput.Type;
export const CommitmentKey = Schema.Struct({
  id: TrimmedNonEmptyString,
  why: TrimmedNonEmptyString,
});
export const CommitmentHistory = Schema.Struct({
  id: TrimmedNonEmptyString,
  commitmentId: TrimmedNonEmptyString,
  fromStatus: Schema.NullOr(CommitmentStatus),
  toStatus: CommitmentStatus,
  who: Schema.String,
  at: IsoDateTime,
  why: Schema.String,
  evidenceRefs: Schema.Array(CommitmentRef),
});
export const CommitmentHistoryInput = Schema.Struct({ id: TrimmedNonEmptyString });
export const CommitmentHistoryResult = Schema.Struct({ history: Schema.Array(CommitmentHistory) });
export const AgentRunAction = Schema.Struct({
  id: TrimmedNonEmptyString,
  agentId: AgentId,
  runId: Schema.NullOr(TrimmedNonEmptyString),
  kind: Schema.String,
  targetId: Schema.NullOr(Schema.String),
  at: IsoDateTime,
});
export type AgentRunAction = typeof AgentRunAction.Type;
export const AgentActivityRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  agentId: AgentId,
  threadId: ThreadId,
  triggerKind: Schema.Literals(["owner_message", "trigger", "approval", "work"]),
  status: Schema.String,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  modelSelection: ModelSelection,
  summary: Schema.NullOr(Schema.String),
});
export const AgentActivityInput = Schema.Struct({ agentId: AgentId });
export const AgentActivityResult = Schema.Struct({
  runs: Schema.Array(AgentActivityRun),
  actions: Schema.Array(AgentRunAction),
});

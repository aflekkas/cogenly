import { AgentPermissions } from "./agent.ts";
import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ScheduledTaskUpsertSchedule } from "./scheduledTaskSchedule.ts";

/**
 * The agent builder: a conversation that ends in an agent. The builder model
 * keeps its live proposal in `propose_agent` calls; each call replaces the
 * thread's `agent_proposal` turn item, which the client renders as the card.
 * The fenced `agent` block stays as a client-side fallback only.
 */

/** The scratch thread a builder conversation runs in is titled like a draft. */
export const BUILDER_THREAD_TITLE = "New agent";

/** Face ids come from the client's face engine; unknown ids fall back to the seed. */
export const AgentBuilderProposalFace = Schema.Struct({
  shape: TrimmedNonEmptyString,
  color: TrimmedNonEmptyString,
  expression: TrimmedNonEmptyString,
});
export type AgentBuilderProposalFace = typeof AgentBuilderProposalFace.Type;

export const AgentBuilderProposalTrigger = Schema.Struct({
  schedule: ScheduledTaskUpsertSchedule,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(32000)),
});
export type AgentBuilderProposalTrigger = typeof AgentBuilderProposalTrigger.Type;

const permissionFields = AgentPermissions.fields;
/** Grants the builder asks for on top of the defaults; absent means default. */
export const AgentBuilderProposalPermissions = Schema.Struct({
  read: Schema.optional(permissionFields.read),
  draft: Schema.optional(permissionFields.draft),
  execute: Schema.optional(permissionFields.execute),
  send: Schema.optional(permissionFields.send),
  create_pr: Schema.optional(permissionFields.create_pr),
  merge: Schema.optional(permissionFields.merge),
  deploy: Schema.optional(permissionFields.deploy),
  delete: Schema.optional(permissionFields.delete),
});
export type AgentBuilderProposalPermissions = typeof AgentBuilderProposalPermissions.Type;

export const AgentBuilderProposal = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  face: AgentBuilderProposalFace,
  responsibility: Schema.String.check(Schema.isMaxLength(32000)),
  instructions: Schema.optional(Schema.String.check(Schema.isMaxLength(32000))),
  triggers: Schema.Array(AgentBuilderProposalTrigger),
  /** Tools or integrations in the builder's words; informational only. */
  needs: Schema.Array(Schema.String),
  permissions: AgentBuilderProposalPermissions,
  /** The new agent's model; absent means the owner's default. */
  model: Schema.optional(ModelSelection),
});
export type AgentBuilderProposal = typeof AgentBuilderProposal.Type;

/** Start a builder conversation. Without a project the server uses Scratch. */
export const AgentBuilderStartInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  modelSelection: ModelSelection,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(32000)),
});
export type AgentBuilderStartInput = typeof AgentBuilderStartInput.Type;

export const AgentBuilderStartResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
});
export type AgentBuilderStartResult = typeof AgentBuilderStartResult.Type;

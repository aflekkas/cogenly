import { AgentEventContext } from "./agentEvent.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ProjectId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectLabelId } from "./projectLabel.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const AgentId = TrimmedNonEmptyString.pipe(Schema.brand("AgentId"));
export type AgentId = typeof AgentId.Type;
/**
 * The seed derives a face; `shape`, `color` and `expression` pin a part of it the
 * owner picked. Clients ignore ids they don't know and fall back to the seed.
 */
export const AgentAvatar = Schema.Struct({
  seed: TrimmedNonEmptyString,
  color: Schema.optional(TrimmedNonEmptyString),
  shape: Schema.optional(TrimmedNonEmptyString),
  expression: Schema.optional(TrimmedNonEmptyString),
});
export type AgentAvatar = typeof AgentAvatar.Type;
export const AgentPermissions = Schema.Struct({
  read: Schema.Boolean,
  draft: Schema.Boolean,
  execute: Schema.Boolean,
  send: Schema.Boolean,
  create_pr: Schema.Boolean,
  merge: Schema.Boolean,
  deploy: Schema.Boolean,
  delete: Schema.Boolean,
});
export type AgentPermissions = typeof AgentPermissions.Type;
/**
 * New agents work on their own across every project: they read, draft and start Work.
 * The high-impact grants stay off until the owner turns them on.
 */
export const defaultAgentPermissions: AgentPermissions = {
  read: true,
  draft: true,
  execute: true,
  send: false,
  create_pr: false,
  merge: false,
  deploy: false,
  delete: false,
};
/** Agents act on their own, within their permissions, across all of the owner's projects. */
const AgentPolicyFields = {
  responsibility: Schema.String.check(Schema.isMaxLength(32000)),
  permissions: AgentPermissions,
  notifyPolicy: Schema.Literals(["action_required", "meaningful_changes", "all"]),
};
/** Why a run left the agent's primary provider entry: its usage limit or its sign-in. */
export const AgentFallbackReason = Schema.Literals(["usage_limit", "auth"]);
export type AgentFallbackReason = typeof AgentFallbackReason.Type;
const AgentFields = {
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  avatar: AgentAvatar,
  instructions: Schema.String.check(Schema.isMaxLength(32000)),
  modelSelection: ModelSelection,
  /**
   * Ordered provider instance + model pairs to try after the primary
   * `modelSelection` when it hits a usage limit or is not signed in.
   * Absent in agents saved before fallback chains; decodes to no chain.
   */
  fallbackChain: Schema.optional(Schema.Array(ModelSelection)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  runtimeMode: RuntimeMode,
  projectId: Schema.NullOr(ProjectId),
  /** Autonomous job starts per UTC day. Owner-initiated conversation turns are not capped. */
  dailyRunCap: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
};
export const Agent = Schema.Struct({
  id: AgentId,
  ownerMachine: Schema.optionalKey(EnvironmentId),
  ...AgentFields,
  ...AgentPolicyFields,
  conversationThreadId: ThreadId,
  /**
   * The project folder the agent's conversation is filed in, read from the
   * conversation thread's folder membership; it is never stored on the agent.
   */
  projectFolderId: Schema.NullOr(ProjectLabelId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  consecutiveFailures: Schema.Int,
  /** Failed background starts back off exponentially; agents are never paused. */
  backoffUntil: Schema.NullOr(IsoDateTime),
  /** Index into [modelSelection, ...fallbackChain] the next background run uses. */
  fallbackIndex: Schema.optional(Schema.Int).pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** Why the chain advanced, and when the primary entry is retried. */
  fallbackReason: Schema.optional(Schema.NullOr(AgentFallbackReason)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  fallbackUntil: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type Agent = typeof Agent.Type;
/** Omit id to create. A project is required for creation; null on edits keeps the conversation's workspace. */
export const AgentUpsertInput = Schema.Struct({
  id: Schema.optional(AgentId),
  ownerMachine: Schema.optionalKey(EnvironmentId),
  ...AgentFields,
  fallbackChain: Schema.optional(Schema.Array(ModelSelection)),
  responsibility: Schema.optional(AgentPolicyFields.responsibility),
  permissions: Schema.optional(AgentPermissions),
  notifyPolicy: Schema.optional(AgentPolicyFields.notifyPolicy),
  /** Files the conversation in a project folder. Omit to keep it; null unfiles it. */
  projectFolderId: Schema.optional(Schema.NullOr(ProjectLabelId)),
  /**
   * On create, the server opens with a hidden first turn from the agent
   * itself, so no fake owner greeting is needed. Ignored on edits.
   */
  kickoff: Schema.optional(Schema.Boolean),
});
export type AgentUpsertInput = typeof AgentUpsertInput.Type;
/** What an agent may change about itself from its own threads. */
export const AgentOwnProfileUpdateInput = Schema.Struct({
  name: Schema.optional(AgentFields.name),
  avatar: Schema.optional(
    Schema.Struct({ ...AgentAvatar.fields, seed: Schema.optional(AgentAvatar.fields.seed) }),
  ),
  responsibility: Schema.optional(AgentPolicyFields.responsibility),
  instructions: Schema.optional(AgentFields.instructions),
  modelSelection: Schema.optional(ModelSelection),
  fallbackChain: Schema.optional(Schema.Array(ModelSelection)),
});
export type AgentOwnProfileUpdateInput = typeof AgentOwnProfileUpdateInput.Type;
export const AgentUpdateInput = Schema.Struct({
  id: AgentId,
  ...AgentOwnProfileUpdateInput.fields,
  permissions: Schema.optional(AgentPermissions),
  runtimeMode: Schema.optional(RuntimeMode),
  dailyRunCap: Schema.optional(AgentFields.dailyRunCap),
  notifyPolicy: Schema.optional(AgentPolicyFields.notifyPolicy),
});
export type AgentUpdateInput = typeof AgentUpdateInput.Type;
export const AgentKey = Schema.Struct({ id: AgentId });
/**
 * Re-file an agent's conversation in a project folder, or null for none. An
 * agent has one ongoing conversation, so it moves instead of forking.
 */
export const AgentSetProjectInput = Schema.Struct({
  id: AgentId,
  projectFolderId: Schema.NullOr(ProjectLabelId),
});
export type AgentSetProjectInput = typeof AgentSetProjectInput.Type;
export const AgentListItem = Schema.Struct({
  ...Agent.fields,
  unreadCount: Schema.Int,
  /** Bounded contact preview; thread shells deliberately omit message bodies. */
  latestMessage: Schema.NullOr(
    Schema.Struct({
      id: MessageId,
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      createdAt: IsoDateTime,
      updatedAt: IsoDateTime,
    }),
  ),
});
export type AgentListItem = typeof AgentListItem.Type;
export const AgentListResult = Schema.Struct({ agents: Schema.Array(AgentListItem) });
/** Advances only through a completed assistant message in this agent's conversation. */
export const AgentMarkReadInput = Schema.Struct({ agentId: AgentId, lastReadMessageId: MessageId });
export type AgentMarkReadInput = typeof AgentMarkReadInput.Type;
export const AgentMarkReadResult = Schema.Struct({ agent: AgentListItem });
export const AgentMutationResult = Schema.Struct({ agent: Agent });
export type AgentMutationResult = typeof AgentMutationResult.Type;
/** Deletes identity, triggers and memory, stops active work, and retains thread history. */
export const AgentDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
/**
 * Uses the normal queue/steer path. Stable commandId/messageId make retries safe.
 * Attachments are pending uploads, claimed into the conversation like a chat send;
 * a text may be empty only when it carries one.
 */
export const AgentSendInput = Schema.Struct({
  id: AgentId,
  commandId: CommandId,
  messageId: MessageId,
  text: TrimmedString,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  mode: Schema.optional(Schema.Literals(["auto", "queue", "steer"])),
}).check(
  Schema.makeFilter(
    (input) =>
      input.text.length > 0 ||
      (input.attachments?.length ?? 0) > 0 ||
      "A message needs text or an attachment.",
  ),
);
export type AgentSendInput = typeof AgentSendInput.Type;
export const AgentSendResult = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
});
export const AgentMemoryNote = Schema.Struct({
  id: TrimmedNonEmptyString,
  agentId: AgentId,
  text: TrimmedNonEmptyString,
  source: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentMemoryNote = typeof AgentMemoryNote.Type;
export const AgentMemoryListInput = Schema.Struct({ agentId: AgentId });
export const AgentMemoryListResult = Schema.Struct({ notes: Schema.Array(AgentMemoryNote) });
export const AgentMemoryWriteInput = Schema.Struct({
  agentId: AgentId,
  id: Schema.optional(TrimmedNonEmptyString),
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(8000)),
  source: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type AgentMemoryWriteInput = typeof AgentMemoryWriteInput.Type;
export const AgentMemoryWriteResult = Schema.Struct({ note: AgentMemoryNote });
export const AgentMemoryForgetInput = Schema.Struct({
  agentId: AgentId,
  id: TrimmedNonEmptyString,
});
/** Trigger runs retain their backend-owned Work threads. Clients show them in Work and can open them from agent activity. */
export const AgentWorkRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  agentId: AgentId,
  triggerId: ScheduledTaskId,
  triggerKind: Schema.optional(Schema.Literals(["trigger", "event"])),
  triggerContext: Schema.optional(AgentEventContext),
  workThreadId: ThreadId,
  status: Schema.Literals(["starting", "running", "completed", "failed"]),
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  summary: Schema.NullOr(Schema.String),
  posted: Schema.Boolean,
  /** The provider instance + model this run actually used; absent on runs predating fallback chains. */
  modelSelection: Schema.optional(ModelSelection),
  /** Set when this run used a fallback entry (or advanced the chain): why. */
  fallbackReason: Schema.optional(AgentFallbackReason),
  /** The failing entry's known reset time, when the provider reported one. */
  fallbackResetAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type AgentWorkRun = typeof AgentWorkRun.Type;
export const AgentRunsResult = Schema.Struct({ runs: Schema.Array(AgentWorkRun) });
export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** App-authored setup and retry inputs are never owner-authored conversation content. */
export const isAgentInternalMessage = (id: string | undefined): boolean =>
  id?.startsWith("agent-kickoff:") === true || id?.startsWith("agent-fallback:") === true;

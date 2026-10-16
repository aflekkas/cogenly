import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  MessageId,
  ProjectId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const AgentId = TrimmedNonEmptyString.pipe(Schema.brand("AgentId"));
export type AgentId = typeof AgentId.Type;
export const AgentAvatar = Schema.Struct({
  seed: TrimmedNonEmptyString,
  color: Schema.optional(TrimmedNonEmptyString),
});
const AgentFields = {
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  avatar: AgentAvatar,
  instructions: Schema.String.check(Schema.isMaxLength(32000)),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  projectId: Schema.NullOr(ProjectId),
  /** Pauses autonomous triggers; owner texts remain available for recovery. */
  enabled: Schema.Boolean,
  /** Autonomous job starts per UTC day. Owner-initiated conversation turns are not capped. */
  dailyRunCap: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
};
export const Agent = Schema.Struct({
  id: AgentId,
  ...AgentFields,
  conversationThreadId: ThreadId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  consecutiveFailures: Schema.Int,
  backoffUntil: Schema.NullOr(IsoDateTime),
  pauseReason: Schema.NullOr(Schema.String),
});
export type Agent = typeof Agent.Type;
/** Omit id to create. A project is required for creation; null on edits keeps the conversation's workspace. */
export const AgentUpsertInput = Schema.Struct({ id: Schema.optional(AgentId), ...AgentFields });
export type AgentUpsertInput = typeof AgentUpsertInput.Type;
export const AgentKey = Schema.Struct({ id: AgentId });
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
/** Deletes identity, triggers and memory, stops active work, and retains thread history. */
export const AgentDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
/** Uses the normal queue/steer path. Stable commandId/messageId make retries safe. */
export const AgentSendInput = Schema.Struct({
  id: AgentId,
  commandId: CommandId,
  messageId: MessageId,
  text: TrimmedNonEmptyString,
  mode: Schema.optional(Schema.Literals(["auto", "queue", "steer"])),
});
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
/** Work threads are backend-owned. Clients exclude these from normal chat lists and open them from run details. */
export const AgentWorkRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  agentId: AgentId,
  triggerId: ScheduledTaskId,
  workThreadId: ThreadId,
  status: Schema.Literals(["starting", "running", "completed", "failed"]),
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  summary: Schema.NullOr(Schema.String),
  posted: Schema.Boolean,
});
export type AgentWorkRun = typeof AgentWorkRun.Type;
export const AgentRunsResult = Schema.Struct({ runs: Schema.Array(AgentWorkRun) });
export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

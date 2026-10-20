import * as Schema from "effect/Schema";
import { AgentId } from "./agent.ts";
import { CommitmentRef } from "./agentWorkspace.ts";
import { IsoDateTime, MessageId, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectLabelId } from "./projectLabel.ts";

export const FactId = TrimmedNonEmptyString.pipe(Schema.brand("FactId"));
export type FactId = typeof FactId.Type;
export const ContextPrincipal = Schema.Union([
  Schema.Literal("user"),
  Schema.TemplateLiteral(["agent:", Schema.String]).check(Schema.isMinLength(7)),
]);
export type ContextPrincipal = typeof ContextPrincipal.Type;
export const FactStatus = Schema.Literals(["proposed", "confirmed", "superseded", "retracted"]);
const FactFields = {
  subject: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  predicate: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(16000)),
  labelIds: Schema.Array(ProjectLabelId).check(Schema.isMaxLength(100)),
  /** user = owner-only, labels = explicit readable label scope. Private agent facts use agentId + user. */
  visibility: Schema.Literals(["user", "labels"]),
  agentId: Schema.optional(AgentId),
  sourceRefs: Schema.Array(CommitmentRef).check(Schema.isMaxLength(100)),
  validFrom: Schema.optional(IsoDateTime),
};
export const FactCreateInput = Schema.Struct(FactFields);
export type FactCreateInput = typeof FactCreateInput.Type;
export const Fact = Schema.Struct({
  id: FactId,
  ...FactFields,
  status: FactStatus,
  supersededBy: Schema.optional(FactId),
  supersedes: Schema.optional(FactId),
  createdBy: ContextPrincipal,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Fact = typeof Fact.Type;
export const FactListInput = Schema.Struct({
  labelId: Schema.optional(ProjectLabelId),
  agentId: Schema.optional(AgentId),
  status: Schema.optional(FactStatus),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
});
export type FactListInput = typeof FactListInput.Type;
export const FactKey = Schema.Struct({ id: FactId });
/** Content corrections create a successor; status changes preserve a history snapshot. */
export const FactUpdateInput = Schema.Struct({
  id: FactId,
  status: Schema.Literals(["proposed", "confirmed", "retracted"]),
});
export type FactUpdateInput = typeof FactUpdateInput.Type;
export const FactSupersedeInput = Schema.Struct({ id: FactId, replacement: FactCreateInput });
export type FactSupersedeInput = typeof FactSupersedeInput.Type;
export const FactResult = Schema.Struct({ fact: Fact });
export const FactListResult = Schema.Struct({ facts: Schema.Array(Fact) });
export const FactHistoryEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  factId: FactId,
  who: ContextPrincipal,
  at: IsoDateTime,
  fact: Fact,
});
export type FactHistoryEntry = typeof FactHistoryEntry.Type;
export const FactHistoryResult = Schema.Struct({ history: Schema.Array(FactHistoryEntry) });
export class FactError extends Schema.TaggedError<FactError>()("FactError", {
  operation: Schema.String,
  reason: Schema.Literals(["storage", "not_found", "forbidden", "invalid_state"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Could not ${this.operation} context (${this.reason}).`;
  }
}

export const ContextItem = Schema.Struct({
  kind: Schema.Literals(["message", "fact", "commitment", "work"]),
  id: Schema.String,
  text: Schema.String,
  refs: Schema.Array(CommitmentRef),
  labelIds: Schema.Array(ProjectLabelId),
  updatedAt: IsoDateTime,
  // Display metadata for the "Context used" panel. All optional so payloads
  // recorded before these fields existed still decode.
  title: Schema.optional(Schema.String),
  snippet: Schema.optional(Schema.String),
  role: Schema.optional(Schema.Literals(["user", "assistant"])),
  sourceThreadId: Schema.optional(ThreadId),
  sourceThreadTitle: Schema.optional(Schema.String),
  sourceMessageId: Schema.optional(MessageId),
  createdAt: Schema.optional(IsoDateTime),
  reason: Schema.optional(Schema.String),
});
export type ContextItem = typeof ContextItem.Type;
export const ContextSet = Schema.Struct({ items: Schema.Array(ContextItem), text: Schema.String });
export type ContextSet = typeof ContextSet.Type;
export const ContextForRunInput = Schema.Struct({ runId: RunId });
export const ContextForRunResult = Schema.Struct({
  runId: RunId,
  refs: Schema.Array(CommitmentRef),
  items: Schema.Array(ContextItem),
});
export const ContextThreadInput = Schema.Struct({ threadId: ThreadId });
export const ContextSetEnabledInput = Schema.Struct({
  threadId: ThreadId,
  enabled: Schema.Boolean,
});
export const ContextSettingsResult = Schema.Struct({ enabled: Schema.Boolean });

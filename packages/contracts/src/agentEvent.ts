import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectLabelId } from "./projectLabel.ts";

export const AgentEventKind = Schema.Literals([
  "work.completed",
  "work.failed",
  "work.review_ready",
  "pr.updated",
  "pr.checks_failed",
  "pr.merged",
  "commitment.due",
]);
export type AgentEventKind = typeof AgentEventKind.Type;
export const AgentEventFilter = Schema.Struct({
  labelIds: Schema.optional(Schema.Array(ProjectLabelId)),
  projectIds: Schema.optional(Schema.Array(ProjectId)),
  origin: Schema.optional(Schema.Literals(["direct", "chat", "agent"])),
});
export const AgentEventContext = Schema.Struct({
  kind: AgentEventKind,
  dedupKey: TrimmedNonEmptyString,
  occurredAt: IsoDateTime,
  projectId: Schema.NullOr(ProjectId),
  labelIds: Schema.Array(ProjectLabelId),
  origin: Schema.Literals(["direct", "chat", "agent"]),
  refs: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    runId: Schema.optional(TrimmedNonEmptyString),
    prUrl: Schema.optional(TrimmedNonEmptyString),
    headSha: Schema.optional(TrimmedNonEmptyString),
    commitmentId: Schema.optional(TrimmedNonEmptyString),
  }),
  /** Inherited through Work and approval launches; bounded before reservation. */
  chainDepth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
  chainAgentIds: Schema.Array(TrimmedNonEmptyString),
  subjectAgentId: Schema.optional(TrimmedNonEmptyString),
});
export type AgentEventContext = typeof AgentEventContext.Type;
export const ScheduledTaskEventSchedule = Schema.Struct({
  type: Schema.Literal("event"),
  event: AgentEventKind,
  filter: Schema.optional(AgentEventFilter),
});

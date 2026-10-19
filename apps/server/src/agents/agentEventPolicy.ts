import type { ResolvedAgentAccess } from "./AgentAccessScope.ts";
import type { AgentEventContext, ScheduledTask } from "@t3tools/contracts";

/** Relevance filters never add authority: repository access remains explicit. */
export function canReceiveAgentEvent(
  access: ResolvedAgentAccess,
  task: ScheduledTask,
  event: AgentEventContext,
): boolean {
  const { agent } = access;
  return (
    task.enabled &&
    agent.enabled &&
    !agent.paused &&
    agent.permissions.read &&
    event.chainDepth < 2 &&
    task.projectId === agent.projectId &&
    (event.projectId === null
      ? event.subjectAgentId === agent.id ||
        event.labelIds.some((id) => access.readableLabelIds.includes(id))
      : access.readableRepositoryIds.includes(event.projectId))
  );
}

export function matchesAgentEvent(task: ScheduledTask, event: AgentEventContext): boolean {
  const trigger = task.schedule;
  if (
    !task.enabled ||
    task.agentId == null ||
    trigger.type !== "event" ||
    trigger.event !== event.kind ||
    task.createdAt > event.occurredAt
  )
    return false;
  const filter = trigger.filter;
  return (
    (!filter?.projectIds?.length ||
      (event.projectId !== null && filter.projectIds.includes(event.projectId))) &&
    (!filter?.labelIds?.length || filter.labelIds.some((id) => event.labelIds.includes(id))) &&
    (filter?.origin === undefined || filter.origin === event.origin)
  );
}

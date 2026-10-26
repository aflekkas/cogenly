import { isAgentInternalMessage, type ModelSelection } from "@cogenly/contracts";

export const CONVERSATION_RECENT_MESSAGES = 20;
export const CONVERSATION_SESSION_RUNS = 40;

/** The latest owner-visible conversation texts, for a background job's context. */
export function recentConversation(
  messages: ReadonlyArray<{ id?: string; role: string; text: string }>,
) {
  return messages
    .filter((message) => !isAgentInternalMessage(message.id))
    .slice(-CONVERSATION_RECENT_MESSAGES)
    .map((m) => `${m.role}: ${m.text}`)
    .join("\n");
}

/**
 * A persistent agent starts a fresh native session every CONVERSATION_SESSION_RUNS owner turns
 * and whenever its provider or model changes. The fresh session gets the validated handoff brief,
 * memory and recent texts instead of resuming another model's native history.
 * Effort and other options stay on the same session.
 */
export function shouldRotateAgentSession(input: {
  readonly runOrdinal: number;
  readonly latestSummaryOrdinal: number;
  readonly previous: Pick<ModelSelection, "instanceId" | "model"> | undefined;
  readonly next: Pick<ModelSelection, "instanceId" | "model">;
}): boolean {
  return (
    input.runOrdinal - input.latestSummaryOrdinal > CONVERSATION_SESSION_RUNS ||
    (input.previous !== undefined &&
      (input.previous.instanceId !== input.next.instanceId ||
        input.previous.model !== input.next.model))
  );
}

/** Owner and agent texts from earlier runs that seed a rotated session, oldest first. */
export function agentSessionSeedItems<
  Item extends { readonly id: string; readonly type: string; readonly runId: string | null },
>(
  history: ReadonlyArray<Item>,
  earlierRunIds: ReadonlySet<string>,
  limit = CONVERSATION_RECENT_MESSAGES,
): ReadonlyArray<Item> {
  return history
    .filter(
      (item) =>
        (item.type === "user_message" || item.type === "assistant_message") &&
        (item.runId === null || earlierRunIds.has(item.runId)),
    )
    .slice(-limit);
}

import type {
  ChatAttachment,
  OrchestrationMessageContext,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

export function isAutomaticCompletionRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  run: OrchestrationV2Run,
): boolean {
  return projection.messages.some(
    (message) => message.id === run.userMessageId && message.delegatedCompletion !== undefined,
  );
}

export function queuedRunsInDeliveryOrder(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
): ReadonlyArray<OrchestrationV2Run> {
  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter((message) => message.delegatedCompletion !== undefined)
      .map((message) => message.id),
  );
  return projection.runs
    .filter((run) => run.status === "queued")
    .toSorted((left, right) => {
      const deliveryPriority =
        Number(automaticCompletionMessageIds.has(right.userMessageId)) -
        Number(automaticCompletionMessageIds.has(left.userMessageId));
      return (
        deliveryPriority ||
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal
      );
    });
}

/**
 * The messages the user queued, in delivery order. Delegated completions and
 * notifications are deliveries, not the user's messages, so bulk queue actions
 * leave them alone.
 */
export function userQueuedMessagesInDeliveryOrder(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
): ReadonlyArray<{
  readonly run: OrchestrationV2Run;
  readonly message: OrchestrationV2ConversationMessage;
}> {
  return queuedRunsInDeliveryOrder(projection).flatMap((run) => {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    return message === undefined ||
      message.delegatedCompletion !== undefined ||
      message.notification !== undefined
      ? []
      : [{ run, message }];
  });
}

/** Separates the queued messages Send all joins into one. */
export const QUEUED_MESSAGE_SEPARATOR = "\n\n";

/**
 * One message carrying several queued ones in order: texts joined by a blank
 * line, attachments and context references kept once each.
 */
export function combineQueuedMessages(
  messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "text" | "attachments" | "context">
  >,
): {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext;
} {
  const attachments = new Map<string, ChatAttachment>();
  const records = new Map<string, OrchestrationMessageContext["records"][number]>();
  for (const message of messages) {
    for (const attachment of message.attachments) {
      if (!attachments.has(attachment.id)) attachments.set(attachment.id, attachment);
    }
    for (const record of message.context?.records ?? []) {
      if (!records.has(record.contextId)) records.set(record.contextId, record);
    }
  }
  return {
    text: messages
      .map((message) => message.text)
      .filter((text) => text.trim().length > 0)
      .join(QUEUED_MESSAGE_SEPARATOR),
    attachments: [...attachments.values()],
    ...(records.size === 0 ? {} : { context: { version: 1, records: [...records.values()] } }),
  };
}

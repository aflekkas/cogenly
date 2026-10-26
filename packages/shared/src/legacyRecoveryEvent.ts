import type { OrchestrationV2DomainEvent } from "@cogenly/contracts";

/**
 * Old recovery passes included related provider threads from shared sessions in
 * the wrong stream. Keep those events as history, but never project their writes
 * into another thread. Only recognize recovery's original allocated event ids.
 */
export const isMisroutedLegacyRecoveryEvent = (event: OrchestrationV2DomainEvent) =>
  event.type === "provider-thread.updated" &&
  event.payload.appThreadId !== null &&
  event.payload.appThreadId !== event.threadId &&
  ["startup", "shutdown"].some((trigger) =>
    event.id.startsWith(
      `event:thread:${encodeURIComponent(event.threadId)}:command:${encodeURIComponent(`command:runtime-reconcile:${trigger}:${event.threadId}:`)}`,
    ),
  );

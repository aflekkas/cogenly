import {
  ProviderThreadId,
  type EnvironmentId,
  type OrchestrationV2DomainEvent,
} from "@cogenly/contracts";

// Native conversations imported independently on two machines can have the same
// provider-thread id under different app threads. Keep the native ref untouched;
// only the application identity and its typed references need a namespace.
const nativeIdentity =
  /^provider-thread:provider:[^:]+:(?:provider-instance:[^:]+:)?native-thread:[^:]+$/;

export const normalizeLegacyProviderThread = (
  event: OrchestrationV2DomainEvent,
  origin: EnvironmentId,
): OrchestrationV2DomainEvent => {
  const scope = (id: ProviderThreadId) =>
    nativeIdentity.test(id)
      ? ProviderThreadId.make(`${id}:machine:${encodeURIComponent(origin)}`)
      : id;
  let payload = event.payload;
  const set = (key: string, value: unknown) => {
    payload = { ...payload, [key]: value } as typeof payload;
  };
  if (event.type === "provider-thread.updated") {
    const id = scope(event.payload.id);
    if (id !== event.payload.id) set("id", id);
  }
  const references = [
    ["providerThreadId", "providerThreadId" in payload ? payload.providerThreadId : null],
    [
      "activeProviderThreadId",
      "activeProviderThreadId" in payload ? payload.activeProviderThreadId : null,
    ],
    ["toProviderThreadId", "toProviderThreadId" in payload ? payload.toProviderThreadId : null],
  ] as const;
  for (const [key, id] of references) {
    if (id === null || id === undefined) continue;
    const scoped = scope(id);
    if (scoped !== id) set(key, scoped);
  }
  if ("fromProviderThreadIds" in payload) {
    const previous = payload.fromProviderThreadIds;
    const ids = previous.map(scope);
    if (ids.some((id, index) => id !== previous[index])) set("fromProviderThreadIds", ids);
  }
  if (
    "forkedFrom" in payload &&
    payload.forkedFrom !== null &&
    "providerThreadId" in payload.forkedFrom
  ) {
    const id = scope(payload.forkedFrom.providerThreadId);
    if (id !== payload.forkedFrom.providerThreadId)
      set("forkedFrom", { ...payload.forkedFrom, providerThreadId: id });
  }
  if (event.type === "context-handoff.updated" && event.payload.history !== undefined) {
    const history = event.payload.history;
    const messages = history.messages.map((message) => {
      if (message.providerThreadId === null) return message;
      const id = scope(message.providerThreadId);
      return id === message.providerThreadId ? message : { ...message, providerThreadId: id };
    });
    if (messages.some((message, index) => message !== history.messages[index]))
      set("history", { ...history, messages });
  }
  return payload === event.payload ? event : ({ ...event, payload } as OrchestrationV2DomainEvent);
};

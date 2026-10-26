import { ProviderThreadId, type OrchestrationV2DomainEvent } from "@cogenly/contracts";

// The old `import:<instance>:<native>` app-thread namespace is distinct from
// `thread:provider:<driver>:native-thread:<native>`. Only the former needs
// a different provider identity; ordinary adapter-created conversations keep
// their native-derived id, including when their app thread changes machines.
export const normalizeLegacyProviderThread = (
  event: OrchestrationV2DomainEvent,
): OrchestrationV2DomainEvent => {
  const imported = /^import:([^:]+):(.+)$/.exec(event.threadId);
  if (imported === null) return event;
  const [, instance, nativeId] = imported;
  // The import namespace contains an instance id, not a driver. References
  // retain the driver even on events that have no driver field themselves.
  const driver = event.driver ?? ("driver" in event.payload ? event.payload.driver : undefined);
  const scope = (id: ProviderThreadId) => {
    const legacy = /^provider-thread:provider:([^:]+):native-thread:(.+)$/.exec(id);
    return legacy !== null &&
      legacy[2] === nativeId &&
      (driver === undefined || legacy[1] === driver)
      ? ProviderThreadId.make(`provider-thread:import:${instance}:${nativeId}`)
      : id;
  };
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
  if (
    event.type === "turn-item.updated" &&
    event.payload.type === "fork" &&
    event.payload.source.type === "provider_thread"
  ) {
    const source = event.payload.source;
    const id = scope(source.providerThreadId);
    if (id !== source.providerThreadId) set("source", { ...source, providerThreadId: id });
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

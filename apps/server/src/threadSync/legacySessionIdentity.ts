import {
  ProviderSessionId,
  type EnvironmentId,
  type OrchestrationV2DomainEvent,
} from "@cogenly/contracts";

// Only the old deterministic process-wide identity needs a namespace. Allocated
// per-thread sessions already include a random id; scoped sessions must stay put.
// Split historical shared processes by thread too: those threads can now have
// different owners after handoff, and must not claim each other's session row.
const legacySession = /^(provider-session:provider-instance:[^:]+:shared)(:machine:[^:]+)?$/;

/** Normalize every session reference in the event contract, leaving native ids and text intact. */
export const normalizeLegacySession = (
  event: OrchestrationV2DomainEvent,
  origin: EnvironmentId,
): OrchestrationV2DomainEvent => {
  const scope = (id: ProviderSessionId) =>
    legacySession.test(id)
      ? ProviderSessionId.make(
          `${id.includes(":machine:") ? id : `${id}:machine:${encodeURIComponent(origin)}`}:thread:${encodeURIComponent(event.threadId)}`,
        )
      : id;
  switch (event.type) {
    case "provider-session.attached":
    case "provider-session.updated": {
      const id = scope(event.payload.id);
      return id === event.payload.id ? event : { ...event, payload: { ...event.payload, id } };
    }
    case "provider-session.detached": {
      const providerSessionId = scope(event.payload.providerSessionId);
      return providerSessionId === event.payload.providerSessionId
        ? event
        : { ...event, payload: { ...event.payload, providerSessionId } };
    }
    case "provider-thread.updated": {
      if (event.payload.providerSessionId === null) return event;
      const providerSessionId = scope(event.payload.providerSessionId);
      return providerSessionId === event.payload.providerSessionId
        ? event
        : { ...event, payload: { ...event.payload, providerSessionId } };
    }
    case "runtime-request.updated": {
      const capability = event.payload.responseCapability;
      if (capability.type !== "live") return event;
      const providerSessionId = scope(capability.providerSessionId);
      return providerSessionId === capability.providerSessionId
        ? event
        : {
            ...event,
            payload: { ...event.payload, responseCapability: { ...capability, providerSessionId } },
          };
    }
    default:
      return event;
  }
};

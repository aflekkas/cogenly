import type { OrchestrationV2AppThread } from "@t3tools/contracts";

/** Old events and downgraded servers omit provenance. Never infer it from model text. */
export function withWorkMetadata<
  T extends Pick<OrchestrationV2AppThread, "agent" | "workOrigin" | "sourceAgentId">,
>(thread: T) {
  return {
    ...thread,
    workOrigin: thread.workOrigin ?? (thread.agent?.role === "work" ? "agent" : "direct"),
    ...(thread.sourceAgentId === undefined && thread.agent?.role === "work"
      ? { sourceAgentId: thread.agent.id }
      : {}),
  };
}

import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

export type WorkStatus =
  | "draft"
  | "queued"
  | "running"
  | "awaiting_input"
  | "review_ready"
  | "completed"
  | "failed"
  | "canceled"
  | "paused";

/**
 * Work status is execution evidence, never assistant prose or provider goal claims.
 * Pending human runtime/secret requests on the latest or a live run -> awaiting_input.
 * Preparing runs and queued runs -> queued; starting/running/waiting runs -> running
 * (waiting alone may mean a tool/subagent, not user input). A stopped/error current
 * provider process parks/fails a live run. Only the active provider thread's session
 * counts; an idle/ready reusable process and unrelated terminal servers do not.
 * With no live run: newest failed -> failed, cancelled/rolled_back -> canceled,
 * interrupted -> paused. Archived/settled idle threads -> completed. Completed runs
 * with a ready checkpoint containing changed files -> review_ready, otherwise
 * completed (execution ended, not a claim that the implementation is correct).
 * No run/process/review evidence -> draft. A later run supersedes old failures,
 * pending requests from older terminal runs, and old cancellation states.
 */
export function deriveWorkStatus(projection: OrchestrationV2ThreadProjection): WorkStatus {
  const { thread, runs } = projection;
  const latest = runs.reduce<(typeof runs)[number] | undefined>(
    (current, run) => (current === undefined || run.ordinal > current.ordinal ? run : current),
    undefined,
  );
  const live = runs.filter((run) =>
    ["preparing", "starting", "running", "waiting"].includes(run.status),
  );
  const relevantRunIds = new Set([
    ...live.map((run) => run.id),
    ...(latest?.status === "completed" ? [latest.id] : []),
  ]);
  if (
    projection.runtimeRequests.some(
      (request) =>
        request.status === "pending" &&
        projection.nodes.some(
          (node) =>
            node.id === request.nodeId && node.runId !== null && relevantRunIds.has(node.runId),
        ) &&
        request.kind !== "auth_refresh" &&
        request.kind !== "dynamic_tool_call",
    ) ||
    projection.turnItems.some(
      (item) =>
        item.type === "secret_request" &&
        item.status === "waiting" &&
        item.runId !== null &&
        relevantRunIds.has(item.runId),
    )
  ) {
    return "awaiting_input";
  }
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  const session = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread?.providerSessionId,
  );
  if (live.length > 0) {
    if (session?.status === "error") return "failed";
    if (session?.status === "stopped") return "paused";
    return live.some((run) => run.status !== "preparing") ? "running" : "queued";
  }
  if (session?.status === "running" || providerThread?.status === "active") return "running";
  if (latest?.status === "queued") return "queued";
  if (
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.settledAt !== null
  )
    return "completed";
  if (latest?.status === "failed") return "failed";
  if (latest?.status === "cancelled" || latest?.status === "rolled_back") return "canceled";
  if (latest?.status === "interrupted") return "paused";
  if (
    projection.checkpoints.some(
      (checkpoint) => checkpoint.status === "ready" && checkpoint.files.length > 0,
    )
  )
    return "review_ready";
  if (latest?.status === "completed") return "completed";
  if (session?.status === "error") return "failed";
  if (session?.status === "stopped") return "paused";
  return "draft";
}

import { OrchestratorMcpFailure, type OrchestrationV2ThreadShell } from "@cogenly/contracts";
import * as Effect from "effect/Effect";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

/** A settled turn retains its tools only while the thread still owns background work. */
export const assertRunOwnership = Effect.fn("mcp.assertRunOwnership")(function* (input: {
  readonly caller:
    | Pick<
        OrchestrationV2ThreadShell,
        | "id"
        | "deletedAt"
        | "archivedAt"
        | "providerInstanceId"
        | "activeRunId"
        | "latestRunId"
        | "pendingBackgroundTasks"
      >
    | undefined;
  readonly scope: McpInvocationScope;
  readonly threads: Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadRecords">;
}) {
  const { caller, scope, threads } = input;
  if (caller === undefined) return;
  const denied = new OrchestratorMcpFailure({
    code: "parent_not_active",
    message: "The calling provider no longer owns an active thread run.",
  });
  if (
    caller.deletedAt !== null ||
    caller.archivedAt !== null ||
    caller.providerInstanceId !== scope.thread?.providerInstanceId ||
    (caller.activeRunId === null && (caller.pendingBackgroundTasks?.length ?? 0) === 0)
  )
    return yield* denied;

  if (caller.activeRunId !== null) return;
  if (caller.latestRunId === null) return yield* denied;
  // Stop commits this marker before the provider finishes interrupting its tasks.
  // Do not let a stale background roster authorize late calls in that interval.
  const projection = yield* threads
    .getThreadRecords(caller.id, ["turnItems"], {
      turnItemTypes: ["run_interrupt_request"],
      turnItemRunIds: [caller.latestRunId],
      messageRoles: [],
    })
    .pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "The operation could not be completed.",
          }),
      ),
    );
  if (projection.turnItems.length > 0) return yield* denied;
});

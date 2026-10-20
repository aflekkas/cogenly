import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Labels from "../../../projectLabels/ProjectLabelService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ProjectLabelsToolkit } from "./tools.ts";
const failure = (error: { reason: string; message: string }) =>
  new OrchestratorMcpFailure({
    code: error.reason === "not_found" ? "invalid_request" : "orchestration_error",
    message: error.message,
  });
export const layer = McpToolAccess.toLayer(ProjectLabelsToolkit, {
  t3_project_label_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.list().pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_label_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.read(input.id).pipe(Effect.mapError(failure));
    }),
  ),
  t3_thread_move_project_folder: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const labels = yield* Labels.ProjectLabelService;
        return yield* labels.moveThread(input).pipe(Effect.mapError(failure));
      }),
  ),
  t3_thread_set_project_labels: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const labels = yield* Labels.ProjectLabelService;
        return yield* labels.setThreadLabels(input, false).pipe(Effect.mapError(failure));
      }),
  ),
});

import {
  OrchestratorMcpFailure,
  ProjectLabelListResult,
  ProjectLabelKey,
  ProjectLabelMutationResult,
  SetThreadProjectLabelsInput,
  ThreadProjectLabelsResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Labels from "../../../projectLabels/ProjectLabelService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Labels.ProjectLabelService,
    Invocation.McpInvocationContext,
    Threads.ThreadManagementService,
  ],
};
export const ProjectLabelsToolkit = Toolkit.make(
  Tool.make("t3_project_label_list", {
    ...shared,
    parameters: Tool.EmptyParams,
    success: ProjectLabelListResult,
    description:
      "List context labels and their linked repository IDs. Labels convey relevance only and never grant access.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_project_label_read", {
    ...shared,
    parameters: ProjectLabelKey,
    success: ProjectLabelMutationResult,
    description:
      "Read one context label and its linked repositories. This does not authorize reading any repository or thread.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_thread_set_project_labels", {
    ...shared,
    parameters: SetThreadProjectLabelsInput,
    success: ThreadProjectLabelsResult,
    description:
      "Replace a thread's context labels with labelIds (empty removes all). Agent assignments are explicit but never marked confirmed by the user. Labels never widen access.",
  }).annotate(Tool.Destructive, true),
);

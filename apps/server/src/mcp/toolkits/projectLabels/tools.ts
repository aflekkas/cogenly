import {
  OrchestratorMcpFailure,
  ProjectLabelListResult,
  ProjectLabelKey,
  ProjectLabelMutationResult,
  SetThreadProjectLabelsInput,
  MoveThreadProjectFolderInput,
  ThreadProjectFolderResult,
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
      "List project folders, their repositories and effective thread counts. Folders provide context only and never grant access.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_project_label_read", {
    ...shared,
    parameters: ProjectLabelKey,
    success: ProjectLabelMutationResult,
    description:
      "Read one project folder and its repositories. This does not authorize reading any repository or thread.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_thread_move_project_folder", {
    ...shared,
    parameters: MoveThreadProjectFolderInput,
    success: ThreadProjectFolderResult,
    description:
      "Move a thread into one project folder. folderId null clears explicit filing and restores the repository default for work. Folders provide context only and never grant access.",
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_thread_set_project_labels", {
    ...shared,
    parameters: SetThreadProjectLabelsInput,
    success: ThreadProjectLabelsResult,
    description:
      "Move a thread into one project folder using a singleton labelIds array. Empty clears explicit filing and restores the repository default for work. Folders never widen access.",
  }).annotate(Tool.Destructive, true),
);

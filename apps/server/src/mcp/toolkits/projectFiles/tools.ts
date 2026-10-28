import {
  OrchestratorMcpFailure,
  ProjectFileReadInput,
  ProjectFilesListInput,
  ProjectFilesListResult,
  ProjectLabelReadResourceResult,
  ProjectRecallInput,
  ProjectRecallResult,
} from "@cogenly/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectFiles from "../../../projectLabels/ProjectFiles.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectFiles.ProjectFiles,
  ],
};

const ProjectFilesListTool = Tool.make("project_files_list", {
  description:
    "List project-relative files/folders with sizes/hashes and folder name/directory. Defaults to this thread's folder; projectFolderId selects another. prefix scopes the listing. Read with project_file_read; search with project_recall.",
  parameters: ProjectFilesListInput,
  success: ProjectFilesListResult,
  ...shared,
})
  .annotate(Tool.Title, "List project files")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ProjectFileReadTool = Tool.make("project_file_read", {
  description:
    "Read a project-relative file in this folder or projectFolderId. Text is paged; binaries report metadata without bytes. Discover via project_files_list/project_recall.",
  parameters: ProjectFileReadInput,
  success: ProjectLabelReadResourceResult,
  ...shared,
})
  .annotate(Tool.Title, "Read a project file")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ProjectRecallTool = Tool.make("project_recall", {
  description:
    "Search project filenames/content and return paths/snippets, here or projectFolderId. Use for references/briefs/notes; read matches with project_file_read.",
  parameters: ProjectRecallInput,
  success: ProjectRecallResult,
  ...shared,
})
  .annotate(Tool.Title, "Search project files")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ProjectFilesToolkit = Toolkit.make(
  ProjectFilesListTool,
  ProjectFileReadTool,
  ProjectRecallTool,
);

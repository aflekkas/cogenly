import {
  OrchestratorMcpFailure,
  ProjectFileReadInput,
  ProjectFilesListInput,
  ProjectFilesListResult,
  ProjectLabelReadResourceResult,
  ProjectRecallInput,
  ProjectRecallResult,
} from "@t3tools/contracts";
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
    "List the files and folders in a Cogenly project folder: user references, briefs, and notes kept alongside the thread's repositories. Reads the calling thread's own folder, or the folder named by projectFolderId (for example one the user @-mentioned). Returns the folder's name and directory on disk plus project-relative paths with sizes and hashes. Pass prefix to scope the listing, e.g. `Resources/`. Read any file with project_file_read, or search filenames and contents with project_recall.",
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
    "Read a file from the calling thread's Cogenly project folder, or the one named by projectFolderId, by project-relative path, e.g. `Resources/brief.md`. Returns paged text for text files and reports binary files (PDFs, images, archives) without their bytes. Find files with project_files_list or project_recall.",
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
    "Search filenames and contents across the calling thread's Cogenly project files, or the folder named by projectFolderId, and return matching paths with snippets. Use it when the thread's project folder may hold relevant references, briefs, or notes; read the matches with project_file_read.",
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

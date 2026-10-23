import {
  OrchestratorMcpFailure,
  ProjectChangeReceipt,
  ProjectFileRemoveInput,
  ProjectFileWriteInput,
  ProjectInstructionsResult,
  ProjectInstructionsSetInput,
  ProjectOverviewResult,
  ProjectRepositoryChangeInput,
  ProjectSourceChangeInput,
  ProjectTargetInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectFiles from "../../../projectLabels/ProjectFiles.ts";
import * as ProjectHome from "../../../projectLabels/ProjectHome.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectFiles.ProjectFiles,
    ProjectHome.ProjectHome,
  ],
};

const target = "Acts on the calling thread's Cogenly project, or the one named by projectFolderId.";
const receipt =
  "Returns a receipt {kind, label, action}; action is unchanged when nothing changed.";

/**
 * Configure a project from inside it: the project chat's own toolset, also
 * open to every other thread filed in the project.
 */
export const ProjectHomeToolkit = Toolkit.make(
  Tool.make("project_overview", {
    ...shared,
    description: `Show the project's configuration: name, instructions, repositories (with ids), linked GitHub sources and its project chat. ${target}`,
    parameters: ProjectTargetInput,
    success: ProjectOverviewResult,
  })
    .annotate(Tool.Title, "Project overview")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("project_instructions_get", {
    ...shared,
    description: `Read the project's instructions, the standing guidance every agent in the project receives. ${target}`,
    parameters: ProjectTargetInput,
    success: ProjectInstructionsResult,
  })
    .annotate(Tool.Title, "Read project instructions")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("project_instructions_set", {
    ...shared,
    description: `Replace the project's instructions with the given text; empty clears them. Read them first and pass the whole new text. They reach every thread in the project from its next session. ${target} ${receipt}`,
    parameters: ProjectInstructionsSetInput,
    success: ProjectChangeReceipt,
  })
    .annotate(Tool.Title, "Set project instructions")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("project_repository_add", {
    ...shared,
    description: `Add an existing repository to the project by id (see project_list). To clone a GitHub repository into the project instead, use project_label_clone_repository. ${target} ${receipt}`,
    parameters: ProjectRepositoryChangeInput,
    success: ProjectChangeReceipt,
  })
    .annotate(Tool.Title, "Add a repository to the project")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("project_repository_remove", {
    ...shared,
    description: `Remove a repository from the project. The repository and its threads are kept. Confirm with the user first. ${target} ${receipt}`,
    parameters: ProjectRepositoryChangeInput,
    success: ProjectChangeReceipt,
  })
    .annotate(Tool.Title, "Remove a repository from the project")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("project_source_link", {
    ...shared,
    description: `Link a GitHub owner {kind:'github-owner',owner} or repository {kind:'github-repo',owner,repo} to the project, so its repositories show up in the repository picker. ${target} ${receipt}`,
    parameters: ProjectSourceChangeInput,
    success: ProjectChangeReceipt,
  })
    .annotate(Tool.Title, "Link a GitHub source")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("project_source_unlink", {
    ...shared,
    description: `Unlink a GitHub owner or repository from the project. Confirm with the user first. ${target} ${receipt}`,
    parameters: ProjectSourceChangeInput,
    success: ProjectChangeReceipt,
  })
    .annotate(Tool.Title, "Unlink a GitHub source")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("project_file_write", {
    ...shared,
    description: `Save a markdown note to the project's Resources/ folder; a taken name gets a numeric suffix, so this never overwrites. ${target} ${receipt}`,
    parameters: ProjectFileWriteInput,
    success: ProjectChangeReceipt,
  })
    .annotate(Tool.Title, "Save a project file")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, false),
  Tool.make("project_file_remove", {
    ...shared,
    description: `Delete a project file or folder by project-relative path (see project_files_list). This deletes from disk; confirm with the user first. ${target} ${receipt}`,
    parameters: ProjectFileRemoveInput,
    success: ProjectChangeReceipt,
  })
    .annotate(Tool.Title, "Remove a project file")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
);

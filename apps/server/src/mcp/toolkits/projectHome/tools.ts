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
} from "@cogenly/contracts";
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

/**
 * Configure a project from inside it: the project chat's own toolset, also
 * open to every other thread filed in the project.
 */
export const ProjectHomeToolkit = Toolkit.make(
  Tool.make("project_overview", {
    ...shared,
    description:
      "Read project name/instructions, repo IDs/local checkout states, linked GitHub sources and project chat. Defaults here; projectFolderId selects another.",
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
    description:
      "Read standing project guidance received by its agents. Defaults here; projectFolderId selects another.",
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
    description:
      "Read first, then replace all project instructions (empty clears); applies next session. Defaults here or projectFolderId. Returns receipt with action:unchanged for no change.",
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
    description:
      "File an existing repository ID (project_list) in this or projectFolderId's project. For cloning use project_label_clone_repository; single repos need no project. Receipt action:unchanged means no change.",
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
    description:
      "Unfile a repository, keeping repo/threads. Confirm first. Defaults here or projectFolderId; returns receipt, action:unchanged for no change.",
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
    description:
      "Link {kind:'github-owner',owner} or {kind:'github-repo',owner,repo} for the repository picker. Defaults here or projectFolderId; returns a receipt.",
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
    description:
      "Unlink a GitHub owner/repository. Confirm first. Defaults here or projectFolderId; returns receipt, action:unchanged for no change.",
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
    description:
      "Save a Markdown note under Resources/ or project-relative folder (created if needed). Suffixes avoid overwrites; syncs to peers. Defaults here or projectFolderId; returns a receipt.",
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
    description:
      "Delete project-relative file/folder from disk. Confirm first; discover via project_files_list. Defaults here or projectFolderId; returns a receipt.",
    parameters: ProjectFileRemoveInput,
    success: ProjectChangeReceipt,
  })
    .annotate(Tool.Title, "Remove a project file")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
);

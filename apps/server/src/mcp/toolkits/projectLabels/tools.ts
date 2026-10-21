import {
  OrchestratorMcpFailure,
  ProjectLabelCloneRepositoryInput,
  ProjectCloneStartResult,
  ProjectLabelCreateInput,
  ProjectLabelDeleteResult,
  ProjectLabelListResult,
  ProjectLabelKey,
  ProjectLabelMutationResult,
  ProjectLabelRepository,
  ProjectLabelSourceLinkInput,
  ProjectLabelUpdateInput,
  SetThreadProjectLabelsInput,
  MoveThreadProjectFolderInput,
  ThreadProjectFolderResult,
  ThreadProjectLabelsResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Path from "effect/Path";
import { Tool, Toolkit } from "effect/ai";
import * as Labels from "../../../projectLabels/ProjectLabelService.ts";
import * as Clones from "../../../project/ProjectCloneTracker.ts";
import * as Projects from "../../../project/ProjectService.ts";
import * as Identities from "../../../project/RepositoryIdentityResolver.ts";
import * as Settings from "../../../serverSettings.ts";
import * as ServerConfig from "../../../config.ts";
import * as Broadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
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
  Tool.make("t3_project_label_create", {
    ...shared,
    parameters: ProjectLabelCreateInput,
    success: ProjectLabelMutationResult,
    description:
      "Create a project folder with a name and an optional color. Folders organize threads and repositories; they provide context only and never grant access.",
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_project_label_update", {
    ...shared,
    parameters: ProjectLabelUpdateInput,
    success: ProjectLabelMutationResult,
    description:
      "Rename a project folder, or change its color or description. Omitted fields are preserved; null clears color or description.",
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_project_label_delete", {
    ...shared,
    parameters: ProjectLabelKey,
    success: ProjectLabelDeleteResult,
    description:
      "Delete a project folder. Its threads and repositories are kept; only the folder and its filing are removed.",
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_project_label_link_source", {
    ...shared,
    parameters: ProjectLabelSourceLinkInput,
    success: ProjectLabelMutationResult,
    description:
      "Link a GitHub owner or repository to a project folder, so owner search and the repository picker know it. Pass {kind:'github-owner',owner} or {kind:'github-repo',owner,repo}.",
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_project_label_unlink_source", {
    ...shared,
    parameters: ProjectLabelSourceLinkInput,
    success: ProjectLabelMutationResult,
    description: "Remove a GitHub owner or repository link from a project folder.",
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_project_label_link_repository", {
    ...shared,
    parameters: ProjectLabelRepository,
    success: ProjectLabelMutationResult,
    description:
      "File an existing repository into a project folder. Its GitHub link is filed with it when the checkout has a remote.",
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_project_label_unlink_repository", {
    ...shared,
    parameters: ProjectLabelRepository,
    success: ProjectLabelMutationResult,
    description: "Remove a repository from a project folder. The repository itself is kept.",
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_project_label_clone_repository", {
    ...shared,
    parameters: ProjectLabelCloneRepositoryInput,
    success: ProjectCloneStartResult,
    description:
      "Clone a repository into a project folder. The destination resolves under the projects root, progress runs on the project-clone subscription, and the repository is filed in the folder. Starts the tracked clone and returns immediately.",
    dependencies: [
      ...shared.dependencies,
      Clones.ProjectCloneTracker,
      Projects.ProjectService,
      Identities.RepositoryIdentityResolver,
      Settings.ServerSettingsService,
      ServerConfig.ServerConfig,
      Broadcaster.VcsStatusBroadcaster,
      Crypto.Crypto,
      Path.Path,
    ],
  })
    .annotate(Tool.Destructive, true)
    .annotate(Tool.OpenWorld, true),
);

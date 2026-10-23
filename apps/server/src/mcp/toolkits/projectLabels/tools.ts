import {
  FileThreadIntoProjectResult,
  ForkThreadToProjectInput,
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
  Tool.make("project_label_list", {
    ...shared,
    parameters: Tool.EmptyParams,
    success: ProjectLabelListResult,
    description:
      "List project folders, their repositories (each with its normalized remote in repositories[].remote, null for a local-only repository, and its directoryName under the project folder), project chat (projectChatThreadId) and effective thread counts. Archived folders carry archivedAt. Folders provide context only and never grant access.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("project_label_read", {
    ...shared,
    parameters: ProjectLabelKey,
    success: ProjectLabelMutationResult,
    description:
      "Read one project folder and its repositories. This does not authorize reading any repository or thread.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("project_label_file_thread", {
    ...shared,
    dependencies: [...shared.dependencies, Crypto.Crypto],
    parameters: ForkThreadToProjectInput,
    success: FileThreadIntoProjectResult,
    description:
      "File a thread into a project. The same thread is re-filed (never forked): it keeps its history, and its next turn runs in the project folder with a fresh provider session seeded from that history. Refused while a turn is running in the thread.",
  }).annotate(Tool.Destructive, false),
  Tool.make("thread_move_project_folder", {
    ...shared,
    parameters: MoveThreadProjectFolderInput,
    success: ThreadProjectFolderResult,
    description:
      "Move a thread into one project folder, or out of it with folderId null (which restores the repository default for work). The same thread is re-filed: a filed chat's next turn runs in the project folder, an unfiled one in its scratch folder, with a fresh provider session seeded from its history. Refused while a turn is running in the thread. Folders provide context only and never grant access.",
  }).annotate(Tool.Destructive, false),
  Tool.make("thread_set_project_labels", {
    ...shared,
    parameters: SetThreadProjectLabelsInput,
    success: ThreadProjectLabelsResult,
    description:
      "Move a thread into one project folder using a singleton labelIds array. Empty clears explicit filing and restores the repository default for work. The same thread is re-filed (never forked); refused while a turn is running in it. Folders never widen access.",
  }).annotate(Tool.Destructive, true),
  Tool.make("project_label_create", {
    ...shared,
    parameters: ProjectLabelCreateInput,
    success: ProjectLabelMutationResult,
    description:
      "Create a project folder with a name, and optionally a color (gray, red, amber, green, teal, blue, violet or pink; not hex), description and instructions. Folders organize threads and repositories; they provide context only and never grant access.",
  }).annotate(Tool.Destructive, false),
  Tool.make("project_label_update", {
    ...shared,
    parameters: ProjectLabelUpdateInput,
    success: ProjectLabelMutationResult,
    description:
      "Change what the Projects page shows for a project: rename it, set its color (gray, red, amber, green, teal, blue, violet or pink; not hex), description, or instructions (standing guidance for every agent in the project). Omitted fields are preserved; null clears color or description; an empty string clears instructions.",
  }).annotate(Tool.Destructive, false),
  Tool.make("project_label_delete", {
    ...shared,
    parameters: ProjectLabelKey,
    success: ProjectLabelDeleteResult,
    description:
      "Delete a project folder. Its threads and repositories are kept; only the folder and its filing are removed. Prefer project_label_archive to put a finished project away.",
  }).annotate(Tool.Destructive, true),
  Tool.make("project_label_archive", {
    ...shared,
    parameters: ProjectLabelKey,
    success: ProjectLabelMutationResult,
    description:
      "Archive a project folder: it leaves the project pickers and moves to the Archived list, but keeps its threads, project chat, repositories and filing. Undo with project_label_unarchive.",
  })
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.Destructive, false),
  Tool.make("project_label_unarchive", {
    ...shared,
    parameters: ProjectLabelKey,
    success: ProjectLabelMutationResult,
    description: "Bring an archived project folder back to the active projects.",
  })
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.Destructive, false),
  Tool.make("project_label_link_source", {
    ...shared,
    parameters: ProjectLabelSourceLinkInput,
    success: ProjectLabelMutationResult,
    description:
      "Link a GitHub owner or repository to a project folder, so owner search and the repository picker know it. Pass {kind:'github-owner',owner} or {kind:'github-repo',owner,repo}.",
  }).annotate(Tool.Destructive, false),
  Tool.make("project_label_unlink_source", {
    ...shared,
    parameters: ProjectLabelSourceLinkInput,
    success: ProjectLabelMutationResult,
    description: "Remove a GitHub owner or repository link from a project folder.",
  }).annotate(Tool.Destructive, false),
  Tool.make("project_label_link_repository", {
    ...shared,
    parameters: ProjectLabelRepository,
    success: ProjectLabelMutationResult,
    description:
      "File an existing repository into a project folder. Its GitHub link is filed with it when the checkout has a remote.",
  }).annotate(Tool.Destructive, false),
  Tool.make("project_label_unlink_repository", {
    ...shared,
    parameters: ProjectLabelRepository,
    success: ProjectLabelMutationResult,
    description:
      "Remove a repository from a project folder. Only the filing changes: the checkout stays on disk, and project_label_link_repository files it again.",
  }).annotate(Tool.Destructive, false),
  Tool.make("project_label_clone_repository", {
    ...shared,
    parameters: ProjectLabelCloneRepositoryInput,
    success: ProjectCloneStartResult,
    description:
      "Clone a repository into a project folder. The destination resolves under the projects root, progress runs on the project-clone subscription, and the repository is filed in the folder. Starts the tracked clone and returns immediately. A clone that fails or is cancelled removes its repository again, so nothing half-made stays filed; clone again to retry. When a checkout of the repository is already on this machine, file it with project_label_link_repository instead of cloning a second copy.",
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

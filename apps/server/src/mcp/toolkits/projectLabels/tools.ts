import {
  FileThreadIntoProjectResult,
  ForkThreadToProjectInput,
  OrchestratorMcpFailure,
  ProjectLabelCloneRepositoryInput,
  ProjectCloneStartResult,
  ProjectLabelCreateInput,
  ProjectFoldersReconcileInput,
  ProjectFoldersReconcileResult,
  ProjectLabelAdoptRepositoryInput,
  ProjectLabelAdoptRepositoryResult,
  ProjectLabelRemoveCheckoutInput,
  ProjectLabelRemoveCheckoutResult,
  ProjectLabelDeleteResult,
  ProjectLabelMergeInput,
  ProjectLabelDismissDuplicateInput,
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
} from "@cogenly/contracts";
import * as Crypto from "effect/Crypto";
import * as Path from "effect/Path";
import { Tool, Toolkit } from "effect/ai";
import * as Labels from "../../../projectLabels/ProjectLabelService.ts";
import * as Clones from "../../../project/ProjectCloneTracker.ts";
import * as Checkout from "../../../project/RepositoryCheckout.ts";
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
      "List project folders, their repositories (each with its normalized remote in repositories[].remote, null for a local-only repository, its directoryName under the project folder, and checkout: ready, not_cloned, missing, cloning or failed on this machine), project chat (projectChatThreadId) and effective thread counts. Archived folders carry archivedAt. Folders provide context only and never grant access.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("project_label_read", {
    ...shared,
    parameters: ProjectLabelKey,
    success: ProjectLabelMutationResult,
    description:
      "Read one project folder and its repositories. Each repository carries checkout: its state on this machine (ready, not_cloned for one linked from another machine, missing, cloning, failed). This does not authorize reading any repository or thread.",
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
      'Create a project folder with a name, and optionally a color (gray, red, amber, green, teal, blue, violet or pink; not hex), description and instructions. Folders organize threads and repositories; they provide context only and never grant access. Projects are for real multi-repo or large efforts; a single repo stays unfiled. Create one only when the user asks for a project to group work in, and never create or suggest one for a single repo. Getting one repository onto a machine, even phrased as "set it up as a project", needs none: clone it with project_clone (outside any project) and register it with project_create, and ask when unsure which the user means. Suggest a project only when work clearly spans several repositories.',
  }).annotate(Tool.Destructive, false),
  Tool.make("project_label_update", {
    ...shared,
    parameters: ProjectLabelUpdateInput,
    success: ProjectLabelMutationResult,
    description:
      "Change what the Projects page shows for a project: rename it, set its color (gray, red, amber, green, teal, blue, violet or pink; not hex), description, or instructions (standing guidance for every agent in the project). Omitted fields are preserved; null clears color or description; an empty string clears instructions.",
  }).annotate(Tool.Destructive, false),
  Tool.make("project_label_merge", {
    ...shared,
    parameters: ProjectLabelMergeInput,
    success: ProjectLabelMutationResult,
    description:
      "Merge sourceId into targetId: move all repositories, source links, threads (including the project chat), agents, schedules, memory labels, settings and local project files into the target. Keep the target's instructions and append different source instructions. Files with conflicting names are renamed, never overwritten. The source project is removed on every paired machine. This cannot be undone automatically; confirm the source and target with the user first.",
  }).annotate(Tool.Destructive, true),
  Tool.make("project_label_dismiss_duplicate", {
    ...shared,
    parameters: ProjectLabelDismissDuplicateInput,
    success: ProjectLabelMutationResult,
    description:
      "Keep two possible duplicate projects separate. Dismiss the suggestion for id and otherId on every paired machine; both projects and all their contents remain.",
  }).annotate(Tool.Destructive, false),
  Tool.make("project_label_undismiss_duplicate", {
    ...shared,
    parameters: ProjectLabelDismissDuplicateInput,
    success: ProjectLabelMutationResult,
    description:
      "Restore the possible-duplicate suggestion for id and otherId on every paired machine after keeping them separate. Both projects and their contents remain.",
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
      "Clone a repository into an existing project folder; it never creates a project. Use it only when the user names that project; otherwise clone with project_clone, outside any project, which is the default for a single repository.The destination resolves under the projects root, progress runs on the project-clone subscription, and the repository is filed in the folder. Starts the tracked clone and returns immediately. A clone that fails or is cancelled removes its repository again, so nothing half-made stays filed; clone again to retry. Passing the remote of a repository the project already links (checkout not_cloned, missing or failed in project_label_read) clones that one onto this machine under its synced directory name instead, and keeps its record on failure so a retry resumes it. When a checkout of the repository is already on this machine, file it with project_label_link_repository instead of cloning a second copy.",
    dependencies: [
      ...shared.dependencies,
      Clones.ProjectCloneTracker,
      Checkout.RepositoryCheckout,
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
  Tool.make("project_label_remove_checkout", {
    ...shared,
    parameters: ProjectLabelRemoveCheckoutInput,
    success: ProjectLabelRemoveCheckoutResult,
    description:
      "Delete this machine's checkout of a repository the project links, keeping the link, the repository record and its threads: checkout then reads missing, and project_label_clone_repository with its remote brings it back. Refused for a repository with no remote, while a turn runs in it, or while it holds work found nowhere else (other worktrees, uncommitted or stashed changes, unpushed commits). Confirm with the user first.",
    dependencies: [...shared.dependencies, Checkout.RepositoryCheckout],
  }).annotate(Tool.Destructive, true),
  Tool.make("project_label_move_repository", {
    ...shared,
    parameters: ProjectLabelAdoptRepositoryInput,
    success: ProjectLabelAdoptRepositoryResult,
    description:
      "Move a linked repository's checkout on this machine into its place in the project folder, <project>/repos/<directoryName> (repos/<repo> for the project's own GitHub owner, repos/<owner>/<repo> for any other), renaming a checkout kept elsewhere under another folder name. Its worktrees are repaired and its record and threads follow. Refused while a turn runs in it or a worktree lives inside it; returns moved:false when it is already in place.",
    dependencies: [...shared.dependencies, Checkout.RepositoryCheckout],
  }).annotate(Tool.Destructive, false),
  Tool.make("project_folders_reconcile", {
    ...shared,
    parameters: ProjectFoldersReconcileInput,
    success: ProjectFoldersReconcileResult,
    description:
      "Find and settle this machine's leftover folders: folders under the projects root that no project claims (left by a deleted project or a failed create, or made by hand). Settings → Projects shows the same list as Leftover folders. Empty leftovers (only the skeleton Cogenly made) are removed automatically, so every one listed holds something. action 'list' returns them; 'adopt' with dirName makes the folder a project of the same name, keeping everything in it; 'trash' with dirName moves it to this machine's Trash, where the user can put it back (trashed:false when it is no longer a leftover). Every action returns the leftovers that remain. Confirm adopt and trash with the user first.",
  }).annotate(Tool.Destructive, true),
);

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
      "List project folders, normalized repository remotes (null for local), directoryName, checkout readiness, projectChatThreadId and effective thread counts. Archived folders have archivedAt. Folder context grants no access.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("project_label_read", {
    ...shared,
    parameters: ProjectLabelKey,
    success: ProjectLabelMutationResult,
    description:
      "Read project folder/repos and local checkout state: ready/not_cloned/missing/cloning/failed. Grants no repository/thread access.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("project_label_file_thread", {
    ...shared,
    dependencies: [...shared.dependencies, Crypto.Crypto],
    parameters: ForkThreadToProjectInput,
    success: FileThreadIntoProjectResult,
    description:
      "Re-file a stopped thread in place, preserving history. Next turn uses project folder and a fresh provider session seeded with history. Refuses running turns.",
  }).annotate(Tool.Destructive, false),
  Tool.make("thread_move_project_folder", {
    ...shared,
    parameters: MoveThreadProjectFolderInput,
    success: ThreadProjectFolderResult,
    description:
      "Re-file a stopped thread with history; folderId:null clears filing (Work restores repo default). Chats next run in project/scratch folder with a fresh seeded session. Folders grant no access.",
  }).annotate(Tool.Destructive, false),
  Tool.make("thread_set_project_labels", {
    ...shared,
    parameters: SetThreadProjectLabelsInput,
    success: ThreadProjectLabelsResult,
    description:
      "Re-file a stopped thread via singleton labelIds; [] clears filing (Work restores repo default). Keeps history, grants no access; refuses running turns.",
  }).annotate(Tool.Destructive, true),
  Tool.make("project_label_create", {
    ...shared,
    parameters: ProjectLabelCreateInput,
    success: ProjectLabelMutationResult,
    description:
      'Create a requested multi-repo project folder with optional description/instructions/color (named palette, never hex). Single repos need no project: project_clone then project_create, even for "set it up as a project"; clarify ambiguity. Folders grant no access.',
  }).annotate(Tool.Destructive, false),
  Tool.make("project_label_update", {
    ...shared,
    parameters: ProjectLabelUpdateInput,
    success: ProjectLabelMutationResult,
    description:
      "Patch project name/color/description/instructions. Colors use named palette, never hex. Omitted fields stay; null clears color/description, empty clears instructions.",
  }).annotate(Tool.Destructive, false),
  Tool.make("project_label_merge", {
    ...shared,
    parameters: ProjectLabelMergeInput,
    success: ProjectLabelMutationResult,
    description:
      "Merge source into target across repositories, sources, threads/chat, agents, schedules, memory, settings and files. Keep target instructions and append different source text; rename conflicting files. Removes source on every machine. Confirm source/target first; no automatic undo.",
  }).annotate(Tool.Destructive, true),
  Tool.make("project_label_dismiss_duplicate", {
    ...shared,
    parameters: ProjectLabelDismissDuplicateInput,
    success: ProjectLabelMutationResult,
    description:
      "Dismiss a duplicate-project suggestion across paired machines; both projects/contents remain.",
  }).annotate(Tool.Destructive, false),
  Tool.make("project_label_undismiss_duplicate", {
    ...shared,
    parameters: ProjectLabelDismissDuplicateInput,
    success: ProjectLabelMutationResult,
    description:
      "Restore a dismissed duplicate suggestion across paired machines; both projects/contents remain.",
  }).annotate(Tool.Destructive, false),
  Tool.make("project_label_delete", {
    ...shared,
    parameters: ProjectLabelKey,
    success: ProjectLabelDeleteResult,
    description:
      "Delete a folder/filing, keeping repos/threads. Prefer reversible project_label_archive for finished work.",
  }).annotate(Tool.Destructive, true),
  Tool.make("project_label_archive", {
    ...shared,
    parameters: ProjectLabelKey,
    success: ProjectLabelMutationResult,
    description:
      "Hide project from pickers into Archived, keeping chat/repos/threads/filing. Undo with project_label_unarchive.",
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
      "Link {kind:'github-owner',owner} or {kind:'github-repo',owner,repo} to a folder for owner search/repository picker.",
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
      "Clone into a named existing project and return immediately with tracked progress. Otherwise use project_clone. Linked missing/not_cloned/failed repos reuse their synced directoryName and keep records on failure. An unfiled local checkout is filed in place; already linked local repos need no clone. For new remotes already checked out, use project_label_link_repository. New records are removed on failure/cancel; retry by cloning again. Failures identify missing sign-ins.",
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
      "Delete only this machine's checkout, preserving project/repo/thread records; clone its remote to restore. Refuses local-only repos, running turns or work unique here (worktrees, dirty/stashed/unpushed changes). Confirm first.",
    dependencies: [...shared.dependencies, Checkout.RepositoryCheckout],
  }).annotate(Tool.Destructive, true),
  Tool.make("project_label_move_repository", {
    ...shared,
    parameters: ProjectLabelAdoptRepositoryInput,
    success: ProjectLabelAdoptRepositoryResult,
    description:
      "Move a linked checkout to <project>/repos/<directoryName> (own owner: repos/<repo>; others: repos/<owner>/<repo>), repairing worktrees and thread records. Refuses running turns or worktrees inside it. moved:false means already placed.",
    dependencies: [...shared.dependencies, Checkout.RepositoryCheckout],
  }).annotate(Tool.Destructive, false),
  Tool.make("project_folders_reconcile", {
    ...shared,
    parameters: ProjectFoldersReconcileInput,
    success: ProjectFoldersReconcileResult,
    description:
      "List unclaimed project-root folders; empty app skeletons are already removed. adopt:{dirName} preserves contents as a project; trash moves to this machine's Trash (false if no longer leftover). Confirm adopt/trash first. Returns remaining leftovers.",
  }).annotate(Tool.Destructive, true),
);

import { scopeThreadRef } from "@cogenly/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@cogenly/contracts";
import { useMemo } from "react";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useThreadShell } from "../state/entities";
import { usePendingProjectFolderStore } from "./pendingProjectFolders";
import { projectLabelKey, scopedRepositoryKey, threadProjectFolderId } from "./projectLabels.logic";
import { composerProjectFolderId } from "./projectMeta.logic";
import { useProjectLabelDirectory } from "./useProjectLabels";

/**
 * The project a composer's thread is in: a draft's pending pick, else the
 * thread's own folder. A Work draft with neither follows its repository's
 * project. The project picker shows it; the Sources picker keeps its list to it.
 */
export function useComposerProjectFolder(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  /** Set on the new-chat screen, where the draft says whether this is a chat. */
  readonly draftId: DraftId | null;
}) {
  const { environmentId, threadId, draftId } = input;
  const environmentIds = useMemo(() => [environmentId], [environmentId]);
  const directory = useProjectLabelDirectory(environmentIds);
  const thread = useThreadShell(
    useMemo(
      () => (threadId === null ? null : scopeThreadRef(environmentId, threadId)),
      [environmentId, threadId],
    ),
  );
  const pending = usePendingProjectFolderStore((state) => {
    if (threadId === null) return null;
    const entry = state.byThreadId[threadId];
    return entry?.environmentId === environmentId ? entry : null;
  });
  const draft = useComposerDraftStore((store) =>
    draftId === null ? undefined : store.draftThreadsByThreadKey[draftId],
  );
  const draftSurface = draft?.surface;
  const isWorkDraft = thread === null && draftSurface === "work";
  // The project a Work draft's repository is in, which it follows unless another is picked.
  const repositoryFolder =
    isWorkDraft && draft
      ? (directory.folderByRepository.get(scopedRepositoryKey(environmentId, draft.projectId)) ??
        null)
      : null;
  const currentId =
    composerProjectFolderId({
      pendingFolderId: pending?.folderId ?? null,
      threadFolderId: thread ? threadProjectFolderId(thread) : null,
    }) ??
    repositoryFolder?.label.id ??
    null;
  const current =
    currentId === null
      ? null
      : (directory.byKey.get(projectLabelKey(environmentId, currentId)) ?? null);
  return { directory, thread, draftSurface, isWorkDraft, currentId, current };
}

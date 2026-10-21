import type { EnvironmentId, ProjectLabelId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

/**
 * The project picked for a draft before its thread exists. Threads are
 * created without a folder, so the choice waits here, keyed by the thread id
 * the draft will become, until PendingProjectFolderCoordinator files the
 * created thread and clears it. Persisted so a reload keeps the draft's pick.
 */
export interface PendingProjectFolder {
  readonly environmentId: EnvironmentId;
  readonly folderId: ProjectLabelId;
}

interface PendingProjectFolderState {
  readonly byThreadId: Readonly<Record<string, PendingProjectFolder>>;
  /** Null picks "No project": nothing to file, so the entry goes. */
  readonly setPending: (threadId: ThreadId, pending: PendingProjectFolder | null) => void;
  readonly clearPending: (threadId: ThreadId) => void;
}

function without(record: Readonly<Record<string, PendingProjectFolder>>, threadId: string) {
  if (!(threadId in record)) return record;
  const next = { ...record };
  delete next[threadId];
  return next;
}

export const usePendingProjectFolderStore = create<PendingProjectFolderState>()(
  persist(
    (set) => ({
      byThreadId: {},
      setPending: (threadId, pending) =>
        set((state) => ({
          byThreadId: pending
            ? { ...state.byThreadId, [threadId]: pending }
            : without(state.byThreadId, threadId),
        })),
      clearPending: (threadId) =>
        set((state) => ({ byThreadId: without(state.byThreadId, threadId) })),
    }),
    {
      name: "cogenly:pending-project-folders:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ byThreadId }) => ({ byThreadId }),
    },
  ),
);

/** Files the thread a draft becomes in `folderId` once it is created. */
export function setPendingProjectFolder(
  threadId: ThreadId,
  pending: PendingProjectFolder | null,
): void {
  usePendingProjectFolderStore.getState().setPending(threadId, pending);
}

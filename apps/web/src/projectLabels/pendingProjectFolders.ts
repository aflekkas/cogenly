import type { EnvironmentId, ProjectLabelId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

/**
 * The project picked for a draft before its thread exists, keyed by the
 * thread id the draft will become. The first send creates the chat already
 * filed in it (the launch's projectFolderId), so it never needs a move;
 * PendingProjectFolderCoordinator only files threads that exist turnless
 * without it. Persisted so a reload keeps the draft's pick.
 */
export interface PendingProjectFolder {
  readonly environmentId: EnvironmentId;
  readonly folderId: ProjectLabelId;
  /** Set while the first send is creating the chat in this project. */
  readonly launching?: boolean;
}

interface PendingProjectFolderState {
  readonly byThreadId: Readonly<Record<string, PendingProjectFolder>>;
  /** Null picks "No project": nothing to file, so the entry goes. */
  readonly setPending: (threadId: ThreadId, pending: PendingProjectFolder | null) => void;
  readonly clearPending: (threadId: ThreadId) => void;
  readonly setLaunching: (threadId: ThreadId, launching: boolean) => void;
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
      setLaunching: (threadId, launching) =>
        set((state) => {
          const entry = state.byThreadId[threadId];
          if (entry === undefined || (entry.launching === true) === launching) return state;
          const { launching: _previous, ...rest } = entry;
          return {
            byThreadId: {
              ...state.byThreadId,
              [threadId]: launching ? { ...rest, launching: true } : rest,
            },
          };
        }),
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

/** The project a draft's chat should be created in, or null when none was picked. */
export function readPendingProjectFolderId(
  threadId: ThreadId,
  environmentId: EnvironmentId,
): ProjectLabelId | null {
  const entry = usePendingProjectFolderStore.getState().byThreadId[threadId];
  return entry?.environmentId === environmentId ? entry.folderId : null;
}

/**
 * Brackets the first send of a draft whose chat is created in its project.
 * While it runs the coordinator leaves the entry alone. Once the chat exists
 * the pick is spent: the launch filed it, and a server too old to do so has
 * already given it a turn, which is never moved. A failed send keeps the pick
 * for the restored draft.
 */
export function beginPendingProjectFolderLaunch(threadId: ThreadId): (created: boolean) => void {
  const store = usePendingProjectFolderStore.getState();
  if (store.byThreadId[threadId] === undefined) return () => {};
  store.setLaunching(threadId, true);
  return (created) => {
    const current = usePendingProjectFolderStore.getState();
    if (created) current.clearPending(threadId);
    else current.setLaunching(threadId, false);
  };
}

/**
 * What the coordinator does with one pending pick: wait for the thread (or
 * its launch), drop a spent pick, or file a thread that exists turnless.
 * A chat with turns is never moved.
 */
export function pendingProjectFolderStep(
  pending: PendingProjectFolder,
  thread: { readonly folderId: ProjectLabelId | null; readonly hasTurns: boolean } | null,
): "wait" | "clear" | "move" {
  if (thread === null) return "wait";
  if (thread.folderId === pending.folderId || thread.hasTurns) return "clear";
  return pending.launching === true ? "wait" : "move";
}

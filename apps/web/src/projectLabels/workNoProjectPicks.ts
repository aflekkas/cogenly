import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * "No project" picked for a Work draft, in the hero or the toolbar, until the
 * Work hero answers it by moving the draft to a repository in no project (or
 * to no repository). The pick leaves nothing to file, so it cannot ride on the
 * pending project entry. Not persisted: the hero answers it right away.
 */
const useWorkNoProjectPickStore = create<{ readonly byThreadId: Readonly<Record<string, true>> }>(
  () => ({ byThreadId: {} }),
);

export function pickNoProjectForWork(threadId: ThreadId): void {
  useWorkNoProjectPickStore.setState((state) => ({
    byThreadId: { ...state.byThreadId, [threadId]: true },
  }));
}

export function answerNoProjectPick(threadId: ThreadId): void {
  useWorkNoProjectPickStore.setState((state) => {
    if (!(threadId in state.byThreadId)) return state;
    const { [threadId]: _answered, ...rest } = state.byThreadId;
    return { byThreadId: rest };
  });
}

export function useWorkNoProjectPicked(threadId: ThreadId | undefined): boolean {
  return useWorkNoProjectPickStore((state) =>
    threadId === undefined ? false : state.byThreadId[threadId] === true,
  );
}

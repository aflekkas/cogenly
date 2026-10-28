import { scopedThreadKey, scopeThreadRef } from "@cogenly/client-runtime/environment";
import type {
  EnvironmentId,
  IntegrationSource,
  LinkContextRecord,
  ScopedThreadRef,
  ThreadId,
} from "@cogenly/contracts";
import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { setRecentThreadEntry, withoutThreadEntry } from "~/lib/recentThreadEntries";
import { resolveStorage } from "~/lib/storage";
import { useThreadShell } from "~/state/entities";
import { useThreadSources } from "~/state/queries";
import { deriveComposerSourcesInUse } from "./composerSourceStack.logic";

const EMPTY_NAMES: ReadonlyArray<string> = [];

/**
 * Sources the user removed from a thread's Sources stack, by integration name.
 * Removing is a view choice on this device: what the agent already read stays
 * in the thread. Mentioning or picking the source again brings it back.
 */
interface RemovedThreadSourcesState {
  removedByThreadKey: Record<string, ReadonlyArray<string>>;
  remove: (ref: ScopedThreadRef, name: string) => void;
  restore: (ref: ScopedThreadRef, name: string) => void;
}

export const useRemovedThreadSourcesStore = create<RemovedThreadSourcesState>()(
  persist(
    (set) => ({
      removedByThreadKey: {},
      remove: (ref, name) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          const current = state.removedByThreadKey[key] ?? EMPTY_NAMES;
          if (current.includes(name)) return state;
          return {
            removedByThreadKey: setRecentThreadEntry(state.removedByThreadKey, key, [
              ...current,
              name,
            ]),
          };
        }),
      restore: (ref, name) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          const current = state.removedByThreadKey[key];
          if (current === undefined || !current.includes(name)) return state;
          const next = current.filter((entry) => entry !== name);
          return {
            removedByThreadKey:
              next.length === 0
                ? withoutThreadEntry(state.removedByThreadKey, key)
                : setRecentThreadEntry(state.removedByThreadKey, key, next),
          };
        }),
    }),
    {
      name: "cogenly:removed-thread-sources:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ removedByThreadKey: state.removedByThreadKey }),
    },
  ),
);

/**
 * What a thread used and made, from the server. Refetched as runs start and
 * finish (the revision), not on every streamed event. Pass `enabled: false`
 * to stay unsubscribed.
 */
export function useThreadSourcesResult(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  enabled = true,
) {
  const ref = threadId === null ? null : scopeThreadRef(environmentId, threadId);
  const shell = useThreadShell(ref);
  const source = shell?.source;
  const revision =
    source === undefined
      ? null
      : `${source.latestRunId ?? ""}:${source.activityRunStatus ?? source.status}`;
  return useThreadSources(
    enabled && threadId !== null && revision !== null
      ? { environmentId, threadId, revision }
      : null,
  );
}

/** The connected integrations a thread is using, for the composer's Sources control. */
export function useComposerSourcesInUse(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly draftContexts: ReadonlyArray<LinkContextRecord>;
  readonly all: ReadonlyArray<IntegrationSource>;
}): IntegrationSource[] {
  const result = useThreadSourcesResult(input.environmentId, input.threadId);
  const threadKey =
    input.threadId === null
      ? null
      : scopedThreadKey(scopeThreadRef(input.environmentId, input.threadId));
  const removed = useRemovedThreadSourcesStore((state) =>
    threadKey === null ? EMPTY_NAMES : (state.removedByThreadKey[threadKey] ?? EMPTY_NAMES),
  );
  const threadSources = result.data?.sources ?? null;
  return useMemo(
    () =>
      deriveComposerSourcesInUse({
        draftContexts: input.draftContexts,
        threadSources,
        removed,
        all: input.all,
      }),
    [input.draftContexts, input.all, threadSources, removed],
  );
}

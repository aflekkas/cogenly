import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { RECENT_THREAD_ENTRY_LIMIT } from "../../lib/recentThreadEntries";
import {
  migratePersistedThreadDetailsDockState,
  selectThreadDetailsDocked,
  useThreadDetailsDockStore,
} from "./threadDetailsDockStore";

const environmentId = EnvironmentId.make("env-1");
const threadA = scopeThreadRef(environmentId, ThreadId.make("thread-a"));
const threadB = scopeThreadRef(environmentId, ThreadId.make("thread-b"));
const docked = (ref: typeof threadA) =>
  selectThreadDetailsDocked(useThreadDetailsDockStore.getState(), ref);

beforeEach(() => {
  useThreadDetailsDockStore.setState({ dockedByThreadKey: {} });
});

describe("useThreadDetailsDockStore", () => {
  it("docks the card in one thread only; a thread never seen starts undocked", () => {
    useThreadDetailsDockStore.getState().setDocked(threadA, true);
    expect(docked(threadA)).toBe(true);
    expect(docked(threadB)).toBe(false);
    // The same thread id on another environment is another thread.
    expect(docked(scopeThreadRef(EnvironmentId.make("env-2"), threadA.threadId))).toBe(false);

    useThreadDetailsDockStore.getState().setDocked(threadA, false);
    expect(useThreadDetailsDockStore.getState().dockedByThreadKey).toEqual({});
  });

  it("remembers a bounded number of threads and forgets deleted ones", () => {
    const store = useThreadDetailsDockStore.getState();
    for (let index = 0; index <= RECENT_THREAD_ENTRY_LIMIT; index += 1) {
      store.setDocked(scopeThreadRef(environmentId, ThreadId.make(`thread-${index}`)), true);
    }
    const keys = Object.keys(useThreadDetailsDockStore.getState().dockedByThreadKey);
    expect(keys).toHaveLength(RECENT_THREAD_ENTRY_LIMIT);
    expect(keys[0]).toBe("env-1:thread-1");

    const newest = scopeThreadRef(
      environmentId,
      ThreadId.make(`thread-${RECENT_THREAD_ENTRY_LIMIT}`),
    );
    store.removeThread(newest);
    expect(docked(newest)).toBe(false);
  });
});

describe("migratePersistedThreadDetailsDockState", () => {
  it("drops the old shared choice and malformed entries", () => {
    expect(migratePersistedThreadDetailsDockState({ docked: true })).toEqual({
      dockedByThreadKey: {},
    });
    expect(
      migratePersistedThreadDetailsDockState({
        dockedByThreadKey: { "env-1:thread-a": true, "env-1:thread-b": "yes", "not-a-key": true },
      }),
    ).toEqual({ dockedByThreadKey: { "env-1:thread-a": true } });
  });
});

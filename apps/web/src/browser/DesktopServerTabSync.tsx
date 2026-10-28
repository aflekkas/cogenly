"use client";

import { scopeThreadRef } from "@cogenly/client-runtime/environment";
import { type EnvironmentId, type ScopedThreadRef, ThreadId } from "@cogenly/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { usePreviewSession } from "~/components/preview/usePreviewSession";
import { applyPreviewServerEvent, useThreadPreviewState } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";

import { withNativeServerTabThread } from "./desktopServerTabThreads.logic";

/**
 * Syncs every thread where the desktop's own server opens a native tab, so
 * `ElectronBrowserHost` mounts its `<webview>`. Only threads on screen sync on
 * their own, and an agent's `preview_open` in any other thread would wait for
 * a webview that never comes.
 */
export function DesktopServerTabSync(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const [threadIds, setThreadIds] = useState<ReadonlySet<ThreadId>>(() => new Set());
  const tracked = useRef(threadIds);

  useEffect(() => {
    // The first value is whatever event came last before this mounted, maybe long closed.
    let first = true;
    return appAtomRegistry.subscribe(
      previewEnvironment.events({ environmentId, input: {} }),
      (result) => {
        if (first) {
          first = false;
          return;
        }
        if (!AsyncResult.isSuccess(result)) return;
        const event = result.value;
        const next = withNativeServerTabThread(tracked.current, event);
        if (next === tracked.current) return;
        tracked.current = next;
        setThreadIds(next);
        // Mounts the webview now; the thread's own sync then checks it against the list.
        applyPreviewServerEvent(
          scopeThreadRef(environmentId, ThreadId.make(event.threadId)),
          event,
        );
      },
      { immediate: true },
    );
  }, [environmentId]);

  const release = (threadId: ThreadId) => {
    if (!tracked.current.has(threadId)) return;
    const next = new Set(tracked.current);
    next.delete(threadId);
    tracked.current = next;
    setThreadIds(next);
  };

  return [...threadIds].map((threadId) => (
    <ThreadPreviewSync
      key={threadId}
      threadRef={scopeThreadRef(environmentId, threadId)}
      onEmpty={release}
    />
  ));
}

/** Keeps one thread's tabs synced until its last tab closes. */
function ThreadPreviewSync(props: {
  readonly threadRef: ScopedThreadRef;
  readonly onEmpty: (threadId: ThreadId) => void;
}) {
  const { threadRef, onEmpty } = props;
  usePreviewSession(threadRef);
  const state = useThreadPreviewState(threadRef);
  const hasSessions = Object.keys(state.sessions).length > 0;
  const [hadSessions, setHadSessions] = useState(false);
  if (hasSessions && !hadSessions) setHadSessions(true);
  const empty = state.listLoaded && !hasSessions && hadSessions;

  useEffect(() => {
    if (empty) onEmpty(threadRef.threadId);
  }, [empty, onEmpty, threadRef.threadId]);

  return null;
}

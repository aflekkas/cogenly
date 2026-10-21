import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useRecordThreadVisit } from "../hooks/useThreadActions";
import {
  autoMarkReadKey,
  releaseThreadUnreadHold,
  shouldAutoMarkThreadRead,
  useThreadUnreadHolds,
} from "../lib/threadReadState";
import { useThreadShell } from "../state/entities";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { resolveThreadLastVisitedAt } from "./Sidebar.logic";

/** How long the thread must be on screen before it counts as read. */
const READ_AFTER_VISIBLE_MS = 600;

function readIsViewing() {
  return (
    typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()
  );
}

function useWindowIsViewing() {
  const [viewing, setViewing] = useState(readIsViewing);
  useEffect(() => {
    const sync = () => setViewing(readIsViewing());
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, []);
  return viewing;
}

/**
 * Marks the open thread read once its latest reply has been on screen for a
 * moment, so the sidebar's unread dot clears (with its fade) when the reply
 * is actually seen. A thread the user just marked unread is held: it stays
 * unread while they stay on it (see `lib/threadReadState`).
 */
export function ThreadReadCoordinator() {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const threadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const thread = useThreadShell(threadRef);
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  const localLastVisitedAt = useUiStateStore((state) =>
    threadKey === null ? undefined : state.threadLastVisitedAtById[threadKey],
  );
  const hold = useThreadUnreadHolds((state) =>
    threadKey === null ? undefined : state.holds[threadKey],
  );
  const isViewing = useWindowIsViewing();
  const recordVisit = useRecordThreadVisit();
  const dispatchedKeyRef = useRef<string | null>(null);

  // Coming to a thread is a fresh look at it: an unread hold from earlier no
  // longer applies, and the thread you left keeps whatever state it had.
  useEffect(() => {
    if (threadKey !== null) releaseThreadUnreadHold(threadKey);
  }, [threadKey]);

  const latestCompletedAt = thread?.latestRun?.completedAt ?? null;
  const lastVisitedAt =
    thread === null
      ? undefined
      : resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const shouldMarkRead =
    threadRef !== null &&
    thread !== null &&
    shouldAutoMarkThreadRead({ latestCompletedAt, lastVisitedAt, isViewing, hold });
  const readKey =
    threadKey === null ? null : autoMarkReadKey(threadKey, latestCompletedAt, lastVisitedAt);

  useEffect(() => {
    if (!shouldMarkRead || threadRef === null || readKey === null) return;
    // Once per read state: a visit in flight is not sent again, while a later
    // rewind (mark unread) changes the key and can be read again.
    if (dispatchedKeyRef.current === readKey) return;
    const timer = window.setTimeout(() => {
      dispatchedKeyRef.current = readKey;
      recordVisit(threadRef);
    }, READ_AFTER_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [readKey, recordVisit, shouldMarkRead, threadRef]);

  return null;
}

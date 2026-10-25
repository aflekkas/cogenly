import { scopeThreadRef } from "@cogenly/client-runtime/environment";
import { isAtomCommandInterrupted } from "@cogenly/client-runtime/state/runtime";
import type { ThreadId } from "@cogenly/contracts";
import { useEffect, useMemo, useRef } from "react";

import { useThreadShell } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  pendingProjectFolderStep,
  usePendingProjectFolderStore,
  type PendingProjectFolder,
} from "./pendingProjectFolders";
import { threadProjectFolderId } from "./projectLabels.logic";
import { reportProjectFolderFailure } from "./useMoveThreadToFolder";

/**
 * Waits for one draft's thread, then files it where the draft said, but only
 * while it is turnless. A first send creates the chat already filed (or, on a
 * server too old for that, with a turn), and a chat with turns never moves:
 * it would need a fork the user did not ask for.
 */
function PendingProjectFolderApplier(props: {
  readonly threadId: ThreadId;
  readonly pending: PendingProjectFolder;
}) {
  const { pending, threadId } = props;
  const thread = useThreadShell(
    useMemo(
      () => scopeThreadRef(pending.environmentId, threadId),
      [pending.environmentId, threadId],
    ),
  );
  const clearPending = usePendingProjectFolderStore((state) => state.clearPending);
  const move = useAtomCommand(serverEnvironment.moveThreadProjectFolder, {
    label: "file new thread in project",
    reportFailure: false,
  });
  const sentRef = useRef(false);
  const step = pendingProjectFolderStep(
    pending,
    thread === null
      ? null
      : { folderId: threadProjectFolderId(thread), hasTurns: thread.latestRun !== null },
  );
  useEffect(() => {
    if (step === "wait") return;
    if (step === "clear") {
      clearPending(threadId);
      return;
    }
    if (sentRef.current) return;
    sentRef.current = true;
    void move({
      environmentId: pending.environmentId,
      input: { threadId, folderId: pending.folderId },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportProjectFolderFailure("Could not add the chat to its project", result);
      }
      clearPending(threadId);
    });
  }, [clearPending, move, pending, step, threadId]);
  return null;
}

/**
 * Fallback filing for threads that came to exist turnless from a draft that
 * had a project picked, without the launch filing them. Mounted once at the
 * root so a navigation away still lands the move.
 */
export function PendingProjectFolderCoordinator() {
  const byThreadId = usePendingProjectFolderStore((state) => state.byThreadId);
  return (
    <>
      {Object.entries(byThreadId).map(([threadId, pending]) => (
        <PendingProjectFolderApplier
          key={threadId}
          threadId={threadId as ThreadId}
          pending={pending}
        />
      ))}
    </>
  );
}

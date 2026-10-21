import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { useThreadShell } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { usePendingProjectFolderStore, type PendingProjectFolder } from "./pendingProjectFolders";
import { threadProjectFolderId } from "./projectLabels.logic";
import { reportProjectFolderFailure } from "./useMoveThreadToFolder";

/** Waits for one draft's thread, then files it where the draft said. */
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
  const filed = thread !== null && threadProjectFolderId(thread) === pending.folderId;
  useEffect(() => {
    if (thread === null) return;
    if (filed) {
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
  }, [clearPending, filed, move, pending, thread, threadId]);
  return null;
}

/**
 * Files threads created from drafts that had a project picked. Mounted once
 * at the root so a send followed by navigating away still lands the move.
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

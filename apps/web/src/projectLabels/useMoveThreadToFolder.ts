import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ProjectLabelId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import type * as Cause from "effect/Cause";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { waitForThreadShell } from "../state/entities";
import { environmentThreadShells } from "../state/threads";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { waitForAtomValue } from "../state/waitForAtomValue";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  projectFolderChangeKind,
  undoFolderId,
  type PriorFiling,
  type ProjectFolderChangeThread,
} from "./projectLabels.logic";

export function reportProjectFolderFailure(
  title: string,
  result: { readonly cause: Cause.Cause<unknown> },
) {
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

export interface FolderRef {
  readonly id: ProjectLabelId;
  readonly name: string;
}

/** The thread being filed, as the sidebar, palette and composer hold it. */
export interface MovableThread extends ProjectFolderChangeThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly runtime: Parameters<typeof threadRuntimeIsActive>[0];
}

// A turn can run for a long while; past this the fork is abandoned, not hung.
const SETTLE_WAIT_MS = 60 * 60_000;

/**
 * Files one thread in a folder, or takes it out with `folder: null` (Work then
 * falls back to its repository's folder). A turnless chat or Work moves and
 * gets a toast that can undo it. A chat with turns cannot be re-parented: it
 * is forked into the project, waiting first for a running turn to settle so
 * the fork carries it, then the new chat opens with a way back to the
 * original. Resolves true once the thread (or its fork) is in the folder.
 */
export function useMoveThreadToFolder() {
  const navigate = useNavigate();
  const move = useAtomCommand(serverEnvironment.moveThreadProjectFolder, {
    label: "move thread to folder",
    reportFailure: false,
  });
  const fork = useAtomCommand(serverEnvironment.forkThreadToProject, {
    label: "fork thread into project",
    reportFailure: false,
  });

  const forkInto = useCallback(
    async (thread: MovableThread, folder: FolderRef): Promise<boolean> => {
      const { environmentId } = thread;
      const sourceRef = scopeThreadRef(environmentId, thread.id);
      if (threadRuntimeIsActive(thread.runtime)) {
        // The fork copies the latest settled turn, so let the running one land.
        const waitingId = toastManager.add({
          type: "info",
          title: `Forking into ${folder.name} when this turn finishes`,
          timeout: 0,
        });
        const settled = await waitForAtomValue({
          registry: appAtomRegistry,
          atom: environmentThreadShells.threadShellAtom(sourceRef),
          predicate: (shell) => shell === null || !threadRuntimeIsActive(shell.runtime),
          timeoutMs: SETTLE_WAIT_MS,
        });
        toastManager.close(waitingId);
        if (!settled) {
          toastManager.add({
            type: "error",
            title: `Could not fork into ${folder.name}`,
            description: "The turn did not finish in time.",
          });
          return false;
        }
      }
      const result = await fork({
        environmentId,
        input: { threadId: thread.id, labelId: folder.id },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportProjectFolderFailure(`Could not fork into ${folder.name}`, result);
        }
        return false;
      }
      const forkRef = scopeThreadRef(environmentId, result.value.threadId);
      // The route only opens a thread the client already knows, so wait for
      // the fork's shell to arrive before going there.
      void waitForThreadShell(forkRef).then(() =>
        navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(forkRef) }),
      );
      const id = toastManager.add({
        type: "success",
        title: `Forked into ${folder.name}`,
        description: "The original chat stays where it was.",
        actionProps: {
          children: "Open original",
          onClick: () => {
            toastManager.close(id);
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(sourceRef),
            });
          },
        },
      });
      return true;
    },
    [fork, navigate],
  );

  const run = useCallback(
    async (input: {
      readonly thread: MovableThread;
      readonly folder: FolderRef | null;
      /** Where the thread was and how, so Undo restores that exact filing. */
      readonly previous: PriorFiling | null;
      readonly undoable?: boolean;
    }): Promise<boolean> => {
      const { thread, folder, previous } = input;
      if (folder !== null && projectFolderChangeKind(thread, folder.id) === "fork") {
        return forkInto(thread, folder);
      }
      const { environmentId } = thread;
      const threadId = thread.id;
      const result = await move({
        environmentId,
        input: { threadId, folderId: folder?.id ?? null },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportProjectFolderFailure(
            folder ? `Could not move to ${folder.name}` : "Could not remove from folder",
            result,
          );
        }
        return false;
      }
      const landed = result.value.projectFolderId;
      // Work taken out of a folder can land back in its repository's.
      const title = folder
        ? `Moved to ${folder.name}`
        : landed !== null && landed === previous?.id
          ? `Still in ${previous.name} through its repository`
          : previous
            ? `Removed from ${previous.name}`
            : "Removed from folder";
      const id = toastManager.add({
        type: "success",
        title,
        ...(input.undoable !== false
          ? {
              actionProps: {
                children: "Undo",
                onClick: () => {
                  toastManager.close(id);
                  void move({
                    environmentId,
                    input: { threadId, folderId: undoFolderId(previous) },
                  }).then((undo) => {
                    if (undo._tag === "Failure" && !isAtomCommandInterrupted(undo)) {
                      reportProjectFolderFailure("Could not undo the move", undo);
                    }
                  });
                },
              },
            }
          : {}),
      });
      return true;
    },
    [forkInto, move],
  );
  return run;
}

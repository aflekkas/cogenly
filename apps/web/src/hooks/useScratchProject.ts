import { scopeProjectRef } from "@cogenly/client-runtime/environment";
import { availableScratchWorkspaceRoot } from "@cogenly/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import type { EnvironmentProject } from "@cogenly/client-runtime/state/shell";
import { ProjectLabelId, type EnvironmentId, type ThreadSurface } from "@cogenly/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { setPendingProjectFolder } from "~/projectLabels/pendingProjectFolders";
import { useEnvironments } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

function reportScratchFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * Threads without a project live in the environment's scratch project, a
 * plain folder the server owns (users see it as "No project"). The server
 * creates it on first use; after that it is an ordinary project on the
 * non-git path, and each thread gets its own subfolder.
 */
export function useScratchProject() {
  const { environments } = useEnvironments();
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();
  const router = useRouter();

  /** The scratch folder of a connected environment, or null when it offers none. */
  const scratchWorkspaceRootFor = useCallback(
    (environmentId: EnvironmentId | null): string | null => {
      const environment = environments.find((entry) => entry.environmentId === environmentId);
      return availableScratchWorkspaceRoot(
        environment?.connection.phase,
        environment?.serverConfig,
      );
    },
    [environments],
  );

  // A thread without a project starts on the machine the user is working on,
  // and only there. With no current machine (the hosted app with nothing
  // open), it starts on the one machine that offers it, never a silent pick.
  const scratchEnvironmentId = useCallback(
    (current: EnvironmentId | null): EnvironmentId | null => {
      if (current !== null) return scratchWorkspaceRootFor(current) !== null ? current : null;
      const offering = environments.filter(
        (entry) => scratchWorkspaceRootFor(entry.environmentId) !== null,
      );
      return offering.length === 1 ? (offering[0]?.environmentId ?? null) : null;
    },
    [environments, scratchWorkspaceRootFor],
  );

  /** Resolves to the scratch project once it is in this client's store. */
  const openScratchProject = useCallback(
    async (
      environmentId: EnvironmentId,
      failureTitle = "Could not start without a repository",
    ): Promise<EnvironmentProject | null> => {
      const result = await openScratch({ environmentId, input: {} });
      if (result._tag === "Success") return result.value;
      if (!isAtomCommandInterrupted(result)) {
        reportScratchFailure(failureTitle, squashAtomCommandFailure(result));
      }
      return null;
    },
    [openScratch],
  );

  /**
   * `replace` swaps the current history entry, for landings that pick the chat themselves.
   * The scratch folder hosts both kinds: `surface` says whether this is a chat or Work
   * without a repository, and defaults to the surface the user is on.
   */
  const startScratchThread = useCallback(
    async (
      environmentId: EnvironmentId,
      options?: {
        readonly replace?: boolean;
        readonly surface?: ThreadSurface;
        /** The project (folder) the new thread is filed in once it is sent. */
        readonly projectFolderId?: ProjectLabelId | null;
      },
    ) => {
      const project = await openScratchProject(environmentId);
      if (project) {
        const started = await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
          replace: options?.replace ?? false,
          ...(options?.surface ? { surface: options.surface } : {}),
        }).catch((error: unknown) => {
          reportScratchFailure("Could not start without a repository", error);
          return null;
        });
        if (started && options?.projectFolderId) {
          setPendingProjectFolder(started.threadId, {
            environmentId: project.environmentId,
            folderId: options.projectFolderId,
          });
        }
      }
    },
    [handleNewThread, openScratchProject],
  );

  /**
   * New chat from Chats mode: always a plain chat on the current machine,
   * never a repository draft. Says so when that machine offers none. Started
   * from a project's page, the chat belongs to that project.
   */
  const startNewChat = useCallback(
    (current: EnvironmentId | null) => {
      const environmentId = scratchEnvironmentId(current);
      if (environmentId === null) {
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: "Chats aren't available here",
            description: "This machine can't start a chat without a repository right now.",
          }),
        );
        return;
      }
      const params: { environmentId?: string; labelId?: string } =
        router.state.matches.at(-1)?.params ?? {};
      const projectFolderId =
        params.labelId !== undefined && params.environmentId === environmentId
          ? ProjectLabelId.make(params.labelId)
          : null;
      void startScratchThread(environmentId, { surface: "chat", projectFolderId });
    },
    [router, scratchEnvironmentId, startScratchThread],
  );

  return {
    scratchWorkspaceRootFor,
    scratchEnvironmentId,
    openScratchProject,
    startScratchThread,
    startNewChat,
  };
}

import { scopeProjectRef } from "@cogenly/client-runtime/environment";
import type { EnvironmentId } from "@cogenly/contracts";
import { useCallback } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useScratchProject } from "~/hooks/useScratchProject";

/**
 * Opens a new chat on `environmentId`, outside any project, with `prompt` in
 * the composer for the user to send. Existing drafts are kept. "Connect with
 * an agent" and machine health's Fix both start their agents this way.
 * Resolves true once the chat is open.
 */
export function useOpenAgentChat(): (
  environmentId: EnvironmentId,
  prompt: string,
) => Promise<boolean> {
  const { openScratchProject } = useScratchProject();
  const newThread = useNewThreadHandler();
  return useCallback(
    async (environmentId, prompt) => {
      const project = await openScratchProject(environmentId);
      if (!project) return false;
      const opened = await newThread(scopeProjectRef(environmentId, project.id), {
        surface: "chat",
      });
      if (!opened) return false;
      useComposerDraftStore.getState().setPrompt(opened.draftId, prompt);
      return true;
    },
    [newThread, openScratchProject],
  );
}

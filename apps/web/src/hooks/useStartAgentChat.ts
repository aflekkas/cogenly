import { scopeThreadRef } from "@cogenly/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import type { EnvironmentId } from "@cogenly/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { toastManager } from "~/components/ui/toast";
import { useScratchProject } from "~/hooks/useScratchProject";
import { newMessageId, newThreadId } from "~/lib/utils";
import { resolveDefaultProviderModelSelection } from "~/providerInstances";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { waitForThreadShell } from "~/state/entities";
import { environmentServerConfigsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useUiStateStore } from "~/uiStateStore";

export interface AgentChatRequest {
  /** The first message, sent as the user's so the agent starts on it right away. */
  readonly prompt: string;
  /** A fixed title. Without one the server names the chat from the prompt. */
  readonly title?: string;
}

/**
 * Starts a new chat on `environmentId`, outside any project, on the default model,
 * already running `request.prompt`, and opens it. The current thread and every
 * draft are left alone. Integration setup and machine health's agent follow-ups
 * start their agents this way. Resolves true once the chat is open.
 */
export function useStartAgentChat(): (
  environmentId: EnvironmentId,
  request: AgentChatRequest,
) => Promise<boolean> {
  const navigate = useNavigate();
  const { openScratchProject } = useScratchProject();
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  return useCallback(
    async (environmentId, request) => {
      const failed = (description: string) => {
        toastManager.add({ type: "error", title: "Couldn't start the chat", description });
        return false;
      };
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
      const modelSelection = config
        ? resolveDefaultProviderModelSelection(
            config.providers,
            config.settings.defaultModelSelection,
          )
        : null;
      if (!modelSelection) return failed("This machine has no provider ready to run it.");
      const project = await openScratchProject(environmentId, "Couldn't start the chat");
      if (!project) return false;
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const result = await startTurn({
        environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: request.prompt,
            attachments: [],
          },
          modelSelection,
          ...(request.title === undefined ? { titleSeed: request.prompt } : {}),
          runtimeMode: "full-access",
          interactionMode: "default",
          bootstrap: {
            createThread: {
              surface: "chat",
              projectId: project.id,
              title: request.title ?? "New chat",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
          createdAt,
        },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return false;
        const cause = squashAtomCommandFailure(result);
        return failed(cause instanceof Error ? cause.message : "Try again in a moment.");
      }
      // The chat lists in Chats; switch now rather than when its shell arrives.
      useUiStateStore.getState().setSidebarMode("chats");
      const ref = scopeThreadRef(environmentId, threadId);
      // The route only opens a thread the client already knows.
      if (!(await waitForThreadShell(ref))) {
        toastManager.add({
          type: "warning",
          title: "Chat started",
          description: "It has not reached this window yet. Open it from Chats.",
        });
        return true;
      }
      await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
      return true;
    },
    [navigate, openScratchProject, startTurn],
  );
}

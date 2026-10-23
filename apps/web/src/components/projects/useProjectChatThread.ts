import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectLabelWithRepositories,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useDefaultAgentModel } from "../../agents/agentsClient";
import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/** Where the project's own chat stands: the thread the page embeds, once there is one. */
export type ProjectChatThread =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly threadRef: ScopedThreadRef }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * The project's one persistent conversation, created on the first visit: the
 * label names it once it exists (`projectChatThreadId`), so every visit and
 * device opens the same thread; until then this asks the server for it once,
 * starting it on the model a new chat here would use.
 */
export function useProjectChatThread(
  environmentId: EnvironmentId,
  label: ProjectLabelWithRepositories | null,
): ProjectChatThread {
  const canEnsure = useAtomValue(serverEnvironment.ensureProjectChat.permissionAtom(environmentId));
  const ensure = useAtomCommand(serverEnvironment.ensureProjectChat, {
    label: "open project chat",
    reportFailure: false,
  });
  const configLoaded = useServerConfigs().has(environmentId);
  const modelSelection = useDefaultAgentModel(environmentId, null);
  const [ensured, setEnsured] = useState<ThreadId | null>(null);
  const [failure, setFailure] = useState<{ reason: string; attempt: string } | null>(null);
  const requested = useRef<string | null>(null);
  const threadId = label?.projectChatThreadId ?? ensured;
  const labelId = label?.id ?? null;
  // Where the chat could run changes with the linked repositories (an
  // environment without Scratch runs it in one), so a new set asks again.
  const attempt = label?.repositoryIds.join("\0") ?? "";

  useEffect(() => {
    if (labelId === null || threadId !== null || requested.current === attempt) return;
    if (!canEnsure || modelSelection === null) return;
    requested.current = attempt;
    void ensure({ environmentId, input: { id: labelId, modelSelection } }).then((result) => {
      if (result._tag === "Success") {
        setEnsured(result.value.threadId);
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setFailure({
          attempt,
          reason:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Could not open the project chat.",
        });
      }
    });
  }, [attempt, canEnsure, ensure, environmentId, labelId, modelSelection, threadId]);

  if (threadId !== null) {
    return { status: "ready", threadRef: scopeThreadRef(environmentId, threadId) };
  }
  if (failure !== null && failure.attempt === attempt) {
    return { status: "unavailable", reason: failure.reason };
  }
  if (!canEnsure) {
    return {
      status: "unavailable",
      reason:
        "This connection can't start the project chat. Start a new chat in the project instead.",
    };
  }
  if (configLoaded && modelSelection === null) {
    return {
      status: "unavailable",
      reason: "Set up a provider in Settings to talk to this project.",
    };
  }
  return { status: "loading" };
}

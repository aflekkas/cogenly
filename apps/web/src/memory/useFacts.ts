import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@cogenly/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@cogenly/client-runtime/state/runtime";
import type {
  EnvironmentId,
  Fact,
  FactCreateInput,
  FactId,
  FactListInput,
  ThreadId,
} from "@cogenly/contracts";
import { useNavigate } from "@tanstack/react-router";

import { toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { agentWorkspaceRpc } from "../rpc/agents";
import { useEnvironmentQuery } from "../state/query";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams } from "../threadRoutes";

const EMPTY_FACTS: ReadonlyArray<Fact> = [];

/** One environment's facts for a server-side filter (project, agent, status). */
export function useFacts(environmentId: EnvironmentId | null, input: FactListInput) {
  const query = useEnvironmentQuery(
    environmentId === null ? null : agentWorkspaceRpc.factsList({ environmentId, input }),
  );
  return {
    facts: query.data?.facts ?? EMPTY_FACTS,
    error: query.error,
    isLoaded: query.data !== null,
    refresh: query.refresh,
  };
}

function settled<A, E>(title: string, result: AtomCommandResult<A, E>): A | null {
  if (result._tag === "Success") return result.value;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
  return null;
}

/**
 * Create, confirm, correct and forget facts. Each resolves to the saved fact, or null
 * after reporting a failure, then calls `onChanged` so open lists re-read.
 */
export function useFactActions(environmentId: EnvironmentId | null, onChanged?: () => void) {
  const canWrite = useAtomValue(agentWorkspaceRpc.factsCreate.permissionAtom(environmentId));
  const create = useOrchestrationCommand(agentWorkspaceRpc.factsCreate, { reportFailure: false });
  const update = useOrchestrationCommand(agentWorkspaceRpc.factsUpdate, { reportFailure: false });
  const supersede = useOrchestrationCommand(agentWorkspaceRpc.factsSupersede, {
    reportFailure: false,
  });
  const retract = useOrchestrationCommand(agentWorkspaceRpc.factsRetract, {
    reportFailure: false,
  });
  const done = (fact: { fact: Fact } | null) => {
    if (fact) onChanged?.();
    return fact?.fact ?? null;
  };
  return {
    canWrite: environmentId !== null && canWrite,
    create: async (input: FactCreateInput) =>
      environmentId === null
        ? null
        : done(settled("Could not remember this", await create({ environmentId, input }))),
    confirm: async (id: FactId) =>
      environmentId === null
        ? null
        : done(
            settled(
              "Could not confirm this fact",
              await update({ environmentId, input: { id, status: "confirmed" } }),
            ),
          ),
    correct: async (id: FactId, replacement: FactCreateInput) =>
      environmentId === null
        ? null
        : done(
            settled(
              "Could not save the correction",
              await supersede({ environmentId, input: { id, replacement } }),
            ),
          ),
    forget: async (id: FactId) =>
      environmentId === null
        ? null
        : done(
            settled("Could not forget this fact", await retract({ environmentId, input: { id } })),
          ),
  };
}

/** Opens a fact's source thread or link; shared by every place facts are listed. */
export function useFactNavigation(environmentId: EnvironmentId | null) {
  const navigate = useNavigate();
  return {
    onOpenThread: (threadId: ThreadId) => {
      if (environmentId === null) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
      });
    },
    onOpenExternal: (href: string) => {
      void readLocalApi()?.shell.openExternal(href);
    },
  };
}

import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ModelSelection,
  RunId,
  ThreadId,
  UsageLimitHandoffCandidate,
} from "@cogenly/contracts";
import { ArrowRightLeftIcon, ChevronDownIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { type UsageMeterMode, useAppearancePreferences } from "~/appearancePreferences";
import { useServerConfigs } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { headroomLabel } from "../usage/usageMeter.logic";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";

/** Stops whose suggestion the user dismissed this session; the menu stays as the way back. */
const dismissedStops = new Set<string>();

/** What the usage-limit banner offers for continuing the stopped turn on another instance. */
export interface UsageLimitHandoffOffer {
  readonly stopKey: string;
  readonly candidates: ReadonlyArray<UsageLimitHandoffCandidate>;
  readonly dismissed: boolean;
  readonly pending: boolean;
  readonly accept: (candidate: UsageLimitHandoffCandidate) => void;
  readonly dismiss: () => void;
}

/**
 * The handoff candidates for a thread's usage-limit stop. Pass a null run when
 * the thread is not stopped; nothing is fetched then. Refetches when the
 * environment's provider snapshots change, so usage stays current.
 */
export function useUsageLimitHandoff(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly runId: RunId | null;
  /** Receives the selection the continuation started on. */
  readonly onAccepted: (modelSelection: ModelSelection) => void;
}): UsageLimitHandoffOffer | null {
  const { environmentId, threadId, runId } = input;
  const active = threadId !== null && runId !== null;
  const canAccept = useAtomValue(
    orchestrationEnvironment.acceptUsageLimitHandoff.permissionAtom(environmentId),
  );
  const query = useEnvironmentQuery(
    active && canAccept
      ? orchestrationEnvironment.usageLimitHandoff({ environmentId, input: { threadId } })
      : null,
  );
  const providers = useServerConfigs().get(environmentId)?.providers;
  const { refresh } = query;
  const fetchedRunId = query.data?.runId ?? null;
  const refreshedFor = useRef<unknown>(null);
  useEffect(() => {
    if (!active || !canAccept) {
      refreshedFor.current = null;
      return;
    }
    // The first fetch comes from mounting; later stops and usage updates refetch.
    if (refreshedFor.current === null) {
      refreshedFor.current = providers;
      return;
    }
    if (refreshedFor.current === providers && fetchedRunId === runId) return;
    refreshedFor.current = providers;
    refresh();
  }, [active, canAccept, providers, fetchedRunId, runId, refresh]);

  const accept = useAtomCommand(orchestrationEnvironment.acceptUsageLimitHandoff, {
    reportFailure: false,
  });
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [, setDismissTick] = useState(0);
  const inFlight = useRef(false);

  const recommendation = query.data;
  if (!active || recommendation === null || recommendation.runId !== runId) return null;
  if (recommendation.candidates.length === 0) return null;
  const stopKey = `${environmentId}:${threadId}:${runId}`;
  return {
    stopKey,
    candidates: recommendation.candidates,
    dismissed: dismissedStops.has(stopKey),
    pending: pendingKey === stopKey,
    dismiss: () => {
      dismissedStops.add(stopKey);
      setDismissTick((tick) => tick + 1);
    },
    accept: (candidate) => {
      // One continuation per stop, however fast the clicks land.
      if (inFlight.current) return;
      inFlight.current = true;
      setPendingKey(stopKey);
      void accept({
        environmentId,
        input: {
          threadId,
          runId,
          instanceId: candidate.instanceId,
          model: candidate.modelSelection.model,
        },
      }).then((result) => {
        inFlight.current = false;
        setPendingKey(null);
        if (result._tag === "Success") {
          input.onAccepted(result.value.modelSelection);
          return;
        }
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: `Could not continue on ${candidateName(candidate)}`,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      });
    },
  };
}

function candidateName(candidate: UsageLimitHandoffCandidate): string {
  return candidate.displayName ?? candidate.instanceId;
}

/** "62% left" or "38% used" per the usage meter preference, "usage unknown"; an old reading says so. */
function usageLabel(candidate: UsageLimitHandoffCandidate, mode: UsageMeterMode): string {
  const { usage } = candidate;
  if (usage.remainingPercent === null) return headroomLabel(null, mode);
  return `${headroomLabel(usage.remainingPercent, mode)}${usage.stale ? " (last checked a while ago)" : ""}`;
}

/**
 * The banner's handoff controls: the top candidate as one click, the rest in
 * a menu with the dismiss. Once dismissed, only the menu remains, so the
 * choice can still be taken back.
 */
export function UsageLimitHandoffActions({ offer }: { offer: UsageLimitHandoffOffer }) {
  const { preferences } = useAppearancePreferences();
  const mode = preferences.usageMeter;
  const [top] = offer.candidates;
  if (top === undefined) return null;
  return (
    <span className="flex items-center gap-0.5">
      {offer.dismissed ? null : (
        <Button
          size="xs"
          variant="outline"
          disabled={offer.pending}
          title={`Hands the conversation to ${candidateName(top)} (${top.modelLabel ?? top.modelSelection.model}) and re-runs your last request. ${usageLabel(top, mode)}.`}
          onClick={() => offer.accept(top)}
        >
          <ArrowRightLeftIcon aria-hidden="true" />
          Continue on {candidateName(top)}
        </Button>
      )}
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              disabled={offer.pending}
              aria-label="Continue on another provider"
            />
          }
        >
          <ChevronDownIcon aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuGroup>
            <MenuGroupLabel>Continue on</MenuGroupLabel>
            {offer.candidates.map((candidate) => (
              <MenuItem
                key={`${candidate.instanceId}:${candidate.modelSelection.model}`}
                onClick={() => offer.accept(candidate)}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">
                    {candidateName(candidate)} ·{" "}
                    {candidate.modelLabel ?? candidate.modelSelection.model}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {usageLabel(candidate, mode)}
                  </span>
                </span>
              </MenuItem>
            ))}
          </MenuGroup>
          {offer.dismissed ? null : (
            <>
              <MenuSeparator />
              <MenuItem onClick={offer.dismiss}>Don't suggest for this limit</MenuItem>
            </>
          )}
        </MenuPopup>
      </Menu>
    </span>
  );
}

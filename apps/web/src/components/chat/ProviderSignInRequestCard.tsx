import {
  providerSignInRequestDisplay,
  secretRequestAnswerInput,
  secretRequestFailureMessage,
  type SecretRequestItem,
} from "@cogenly/client-runtime/secret-request";
import { providerSignInTitle } from "@cogenly/client-runtime/provider-sign-in";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@cogenly/contracts";
import { CheckIcon, LockIcon, MinusIcon } from "lucide-react";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderSignInCard } from "../providers/ProviderSignInCard";
import { Button } from "../ui/button";
import { WorkLogRow } from "./WorkLog";

/**
 * An agent's provider_sign_in, inline in its thread. The card closes when the
 * machine reports the provider signed in, which also wakes the agent; Not now
 * tells the agent the user declined.
 */
export function ProviderSignInRequestCard({
  environmentId,
  item,
  visibility,
}: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem & {
    readonly providerSignIn: NonNullable<SecretRequestItem["providerSignIn"]>;
  };
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    reportFailure: false,
    reportDefect: false,
  });
  const [declining, setDeclining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const display = providerSignInRequestDisplay(item, visibility);
  if (display.kind !== "pending") {
    const Icon =
      display.kind === "pending-elsewhere"
        ? LockIcon
        : display.outcome === "saved"
          ? CheckIcon
          : MinusIcon;
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <>
            {providerSignInTitle(item.providerSignIn)} · {display.label}
          </>
        }
      />
    );
  }
  const decline = async () => {
    const input = secretRequestAnswerInput(item, { type: "decline" });
    if (input === null || declining) return;
    setDeclining(true);
    setError(null);
    const result = await answer({ environmentId, input });
    setDeclining(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      setError(secretRequestFailureMessage(squashAtomCommandFailure(result)));
  };
  return (
    <div data-v2-item-type={item.type} className="flex flex-col gap-1">
      <ProviderSignInCard
        request={{
          environmentId,
          targetEnvironmentId: item.providerSignIn.targetEnvironmentId,
          instanceId: item.providerSignIn.instanceId,
          providerName: item.providerSignIn.providerName,
          machineName: item.providerSignIn.machineName,
        }}
        description={item.reason}
      >
        <Button size="sm" variant="ghost-muted" disabled={declining} onClick={() => void decline()}>
          Not now
        </Button>
      </ProviderSignInCard>
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

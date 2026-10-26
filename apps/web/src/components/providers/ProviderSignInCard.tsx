import { providerSignInTitle } from "@cogenly/client-runtime/provider-sign-in";
import { KeyRoundIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ThreadPromptCard } from "../chat/ThreadPromptCard";
import {
  ProviderSignInFlow,
  type ProviderSignInRequest,
  useProviderSignInFlow,
  useResolvedProviderSignIn,
} from "./ProviderSignInFlow";

/**
 * The guided sign-in inline in a thread: for an agent's provider_sign_in and
 * for a turn that failed because its provider is signed out. Signing in starts
 * from the card's button, never on its own when the thread loads.
 */
export function ProviderSignInCard({
  request,
  description,
  onSucceeded,
  children,
}: {
  readonly request: ProviderSignInRequest;
  readonly description: ReactNode;
  readonly onSucceeded?: () => void;
  /** Actions beside the flow's own, such as Not now. */
  readonly children?: ReactNode;
}) {
  const target = useResolvedProviderSignIn(request);
  const flow = useProviderSignInFlow(target, { autoStart: false, onSucceeded });
  return (
    <ThreadPromptCard data-provider-sign-in>
      <div className="flex min-w-0 items-start gap-3">
        <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-icon-muted" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium text-foreground">{providerSignInTitle(target)}</p>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{description}</p>
        </div>
      </div>
      <ProviderSignInFlow target={target} flow={flow}>
        {children}
      </ProviderSignInFlow>
    </ThreadPromptCard>
  );
}

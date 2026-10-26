import { isProviderSignInActive } from "@cogenly/client-runtime/provider-sign-in";
import type { EnvironmentId, ProviderInstanceId } from "@cogenly/contracts";

import {
  ProviderSignInFlow,
  useProviderSignInFlow,
  useResolvedProviderSignIn,
} from "../providers/ProviderSignInFlow";
import { Button } from "../ui/button";
import { WizardFooter, WizardPanel } from "../ui/wizard";

/** Sign-in uses the saved instance's environment and credentials, just like chat. */
export function ProviderWizardAuthenticationStep({
  environmentId,
  environmentLabel,
  instanceId,
  onFinish,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly onFinish: () => void;
}) {
  const target = useResolvedProviderSignIn({
    environmentId,
    instanceId,
    machineName: environmentLabel,
  });
  const flow = useProviderSignInFlow(target, { autoStart: false });
  const signedIn = flow.step.kind === "succeeded";
  // Leaving mid-flow would strand it on the machine; Cancel ends it first.
  const busy = isProviderSignInActive(flow.step);
  return (
    <>
      <WizardPanel className="min-h-72">
        <ProviderSignInFlow target={target} flow={flow} />
      </WizardPanel>
      <WizardFooter>
        <Button
          size="sm"
          variant={signedIn ? "default" : "outline"}
          disabled={busy && !signedIn}
          onClick={onFinish}
        >
          {signedIn ? "Done" : "Skip for now"}
        </Button>
      </WizardFooter>
    </>
  );
}

import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@cogenly/contracts";
import { useEnvironmentMachineList } from "../../machines/useMachines";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { SettingsRow } from "./settingsLayout";

/** Sign-in stays with the target machine; only the OAuth instructions cross the paired link. */
export function ProviderMachineSignIns({
  environmentId,
  instanceId,
  provider,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly readOnly: boolean;
}) {
  const list = useEnvironmentMachineList(environmentId);
  const machines = list?.machines ?? [];
  const signedIn = machines
    .filter((machine) =>
      machine.providers.some(
        (entry) => entry.instanceId === instanceId && entry.auth === "authenticated",
      ),
    )
    .map((machine) => machine.name);
  return (
    <>
      {signedIn.length > 0 ? (
        <SettingsRow title="Machines" description={`Signed in on ${signedIn.join(" · ")}`} />
      ) : null}
      {machines
        .filter((machine) => machine.relation !== "this")
        .map((machine) => {
          const remote = machine.providers.find((entry) => entry.instanceId === instanceId);
          if (readOnly || !machine.online || !remote || remote.canAuthenticate === false)
            return (
              <SettingsRow
                key={machine.environmentId}
                title={machine.name}
                description={
                  readOnly && machine.online && remote
                    ? remote.auth === "authenticated"
                      ? "Signed in."
                      : remote.auth === "unauthenticated"
                        ? "Not signed in."
                        : "Sign-in state unavailable."
                    : !machine.online
                      ? "Offline. Sign-in state will update when this machine reconnects."
                      : remote?.canAuthenticate === false
                        ? "This provider requires sign-in on the machine itself."
                        : "Waiting for provider configuration to sync."
                }
              />
            );
          return (
            <ProviderAuthenticationSection
              key={machine.environmentId}
              environmentId={environmentId}
              targetEnvironmentId={machine.environmentId}
              environmentLabel={machine.name}
              instanceId={instanceId}
              provider={{
                ...provider,
                enabled: remote.enabled,
                installed: remote.installed ?? provider.installed,
                auth: { status: remote.auth },
                setup: { canAuthenticate: true, canInstall: false },
              }}
              readOnly={readOnly}
            />
          );
        })}
    </>
  );
}

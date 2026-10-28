import { useAtomValue } from "@effect/atom-react";
import {
  providerMachineSignIns,
  providerSignedOutLabel,
  type ProviderMachineSignIn,
} from "@cogenly/client-runtime/provider-sign-in";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@cogenly/contracts";
import { useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { useEnvironmentMachineList } from "../../machines/useMachines";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { openProviderSignIn } from "../providers/ProviderSignInDialog";
import { Button } from "../ui/button";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SettingsRow } from "./settingsLayout";

/**
 * A provider's account on every machine, one row each, the machine these
 * settings are for first. Each machine signs in on its own; only the browser
 * step happens on this device.
 */
export function ProviderAccountMachines({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  readOnly,
  skipCurrent = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly readOnly: boolean;
  /** The current machine's account is shown elsewhere (Codex's managed setup). */
  readonly skipCurrent?: boolean;
}) {
  const list = useEnvironmentMachineList(environmentId);
  const listed = providerMachineSignIns({ viaEnvironmentId: environmentId, list, instanceId });
  // A server that does not list machines still knows its own provider.
  const rows: ReadonlyArray<ProviderMachineSignIn> =
    listed.length > 0
      ? listed
      : [
          {
            environmentId,
            instanceId,
            providerName: provider.displayName?.trim() || instanceId,
            machineName: environmentLabel,
            auth: provider.auth.status,
            canSignIn: provider.setup?.canAuthenticate !== false,
            online: true,
            current: true,
          },
        ];
  return (
    <>
      {rows
        .filter((row) => !(skipCurrent && row.current))
        .map((row) => (
          <ProviderAccountMachineRow
            key={row.targetEnvironmentId ?? "current"}
            row={row}
            provider={provider}
            readOnly={readOnly}
          />
        ))}
    </>
  );
}

function ProviderAccountMachineRow({
  row,
  provider,
  readOnly,
}: {
  readonly row: ProviderMachineSignIn;
  readonly provider: ServerProvider;
  readonly readOnly: boolean;
}) {
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, {
    reportFailure: false,
    reportDefect: false,
  });
  const canManage = useAtomValue(
    serverEnvironment.logoutProviderAuth.permissionAtom(row.environmentId),
  );
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signedIn = row.auth === "authenticated";
  // Only this server's own provider reports the account's email.
  const email = !row.targetEnvironmentId && signedIn ? provider.auth.email?.trim() : undefined;
  const request = {
    environmentId: row.environmentId,
    targetEnvironmentId: row.targetEnvironmentId,
    instanceId: row.instanceId,
    providerName: row.providerName,
    machineName: row.machineName,
  };
  const actionable = !readOnly && canManage && row.online && row.canSignIn;

  const signOut = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Sign out of ${row.providerName} on ${row.machineName}? Running threads that use this sign-in stop. Thread history is kept.`,
    );
    if (!confirmed) return;
    setSigningOut(true);
    setError(null);
    const result = await logout({
      environmentId: row.environmentId,
      input: {
        instanceId: row.instanceId,
        ...(row.targetEnvironmentId ? { targetEnvironmentId: row.targetEnvironmentId } : {}),
      },
    });
    setSigningOut(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not sign out. Try again.");
    }
  };

  return (
    <SettingsRow
      title={row.machineName}
      description={
        !row.online ? (
          "Offline. Its sign-in updates when it reconnects."
        ) : !row.canSignIn ? (
          `${row.providerName} signs in on ${row.machineName} itself, outside Cogenly.`
        ) : email ? (
          <span>
            Signed in as{" "}
            <RedactedSensitiveText
              key={email}
              value={email}
              ariaLabel="Toggle account email visibility"
              revealTooltip="Click to reveal email"
              hideTooltip="Click to hide email"
              className="max-w-full truncate"
            />
          </span>
        ) : signedIn ? (
          "Signed in."
        ) : row.auth === "unauthenticated" ? (
          `${providerSignedOutLabel(row.machineName)}.`
        ) : (
          "Sign-in status unavailable."
        )
      }
      status={
        error ? (
          <p role="alert" className="[overflow-wrap:anywhere]">
            {error}
          </p>
        ) : undefined
      }
      control={
        actionable ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              size="sm"
              variant={signedIn ? "outline" : "default"}
              disabled={signingOut}
              onClick={() =>
                void openProviderSignIn(signedIn ? { ...request, changeAccount: true } : request)
              }
            >
              {signedIn ? "Change account" : "Sign in"}
            </Button>
            {signedIn && (row.targetEnvironmentId || provider.auth.canLogout !== false) ? (
              <Button
                size="sm"
                variant="outline"
                disabled={signingOut}
                onClick={() => void signOut()}
              >
                {signingOut ? "Signing out" : "Sign out"}
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    />
  );
}

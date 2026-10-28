import type { ComputerUseStatus, EnvironmentId } from "@cogenly/contracts";
import { useEffect } from "react";

import { AnimatedHeight } from "~/components/AnimatedHeight";
import { PlatformStatus } from "~/components/device/DeviceSetup";
import { Button } from "~/components/ui/button";

import {
  computerUseAvailable,
  computerUseHostAppNote,
  computerUseUnsupportedLine,
} from "../../computerUse/computerUse.logic";
import {
  useComputerUseStatus,
  useRequestComputerUsePermission,
} from "../../computerUse/useComputerUse";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const STALE_RETRY_MS = 1_500;

/**
 * The selected machine's macOS grants for computer use, under its toggle. It
 * re-reads while one is missing, so flipping the switch in System Settings
 * shows here without a reload. Hidden while computer use is off.
 */
export function ComputerUsePermissionsSetting({ enabled }: { readonly enabled: boolean }) {
  const { environment, connectedEnvironments } = useSettingsScope();
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const environmentId = connected ? environment.environmentId : null;
  const { status, refresh } = useComputerUseStatus(environmentId);
  const machineNote =
    connectedEnvironments.length > 1 && environment ? `Status for ${environment.label}.` : null;
  // A status read while the toggle was off says `disabled`; read again until
  // the server has the toggle back on.
  const stale = enabled && status?.state === "disabled";
  useEffect(() => {
    if (!stale) return;
    refresh();
    const timer = setInterval(refresh, STALE_RETRY_MS);
    return () => clearInterval(timer);
  }, [refresh, stale]);

  return (
    <AnimatedHeight>
      {!enabled || status === null || status.state === "disabled" ? null : (
        <ComputerUsePermissionsRow
          environmentId={environmentId}
          status={status}
          machineNote={machineNote}
          onRequested={refresh}
        />
      )}
    </AnimatedHeight>
  );
}

function ComputerUsePermissionsRow({
  environmentId,
  status,
  machineNote,
  onRequested,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly status: ComputerUseStatus;
  readonly machineNote: string | null;
  readonly onRequested: () => void;
}) {
  const { canRequest, pending, request } = useRequestComputerUsePermission(environmentId);
  // Which app to grant only matters while a grant is missing.
  const missingGrant = status.permissions.some((entry) => entry.grant !== "granted");
  const description =
    computerUseUnsupportedLine(status) ??
    ([machineNote, missingGrant ? computerUseHostAppNote(status) : null]
      .filter(Boolean)
      .join(" ") ||
      undefined);

  return (
    <SettingsRow id="computer-use-permissions" title="macOS permissions" description={description}>
      {computerUseAvailable(status) ? (
        // One subrow per grant: its state on the left, its action on the row's trailing edge.
        <ul className="space-y-2 pt-1 pb-2">
          {status.permissions.map((entry) => (
            <li key={entry.permission} className="flex min-h-7 items-center justify-between gap-4">
              <PlatformStatus
                compact
                platform={entry.title}
                readyLabel="Granted"
                status={{ ready: entry.grant === "granted", message: "Not granted" }}
              />
              {entry.grant === "granted" ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canRequest || pending}
                  aria-label={`Open System Settings for ${entry.title}`}
                  onClick={() => void request(entry.permission).then(onRequested)}
                >
                  Open System Settings
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsRow>
  );
}

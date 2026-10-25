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
  const description =
    computerUseUnsupportedLine(status) ??
    ([machineNote, computerUseHostAppNote(status)].filter(Boolean).join(" ") || undefined);

  return (
    <SettingsRow
      id="computer-use-permissions"
      title="macOS permissions"
      description={description}
      status={
        computerUseAvailable(status) ? (
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {status.permissions.map((entry) => (
              <div key={entry.permission} className="flex items-center gap-3">
                <PlatformStatus
                  compact
                  platform={entry.title}
                  readyLabel="Granted"
                  status={{ ready: entry.grant === "granted", message: "Not granted" }}
                />
                {entry.grant === "granted" ? null : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!canRequest || pending}
                    onClick={() => void request(entry.permission).then(onRequested)}
                  >
                    Open System Settings
                  </Button>
                )}
              </div>
            ))}
          </div>
        ) : undefined
      }
    />
  );
}

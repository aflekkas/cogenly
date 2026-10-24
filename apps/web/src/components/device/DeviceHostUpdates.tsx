import type { DeviceServiceState, EnvironmentId } from "@cogenly/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { deviceEnvironment } from "~/state/device";
import { useAtomCommand } from "~/state/use-atom-command";

const SHOWN_HOST_STATUSES = new Set(["installing", "starting", "failed"]);

/** Whether any host has an install, start or failure card to show. */
export function deviceHostUpdateShown(state: DeviceServiceState): boolean {
  return (
    state.hostStatus !== "disabled" &&
    state.hosts.some((host) => SHOWN_HOST_STATUSES.has(state.hostStatuses[host.id]?.status ?? ""))
  );
}

/** Shared by setup, Settings, and the Device panel so automatic updates stay visible. */
export function DeviceHostUpdates({
  state,
  environmentId,
}: {
  state: DeviceServiceState;
  environmentId: EnvironmentId;
}) {
  const retry = useAtomCommand(deviceEnvironment.list);
  const [pending, setPending] = useState<string | null>(null);
  if (state.hostStatus === "disabled") return null;
  return (
    <div className="space-y-2">
      {state.hosts.map((host) => {
        const status = state.hostStatuses[host.id];
        if (!status || !SHOWN_HOST_STATUSES.has(status.status)) return null;
        const failed = status.status === "failed";
        return (
          <div
            key={host.id}
            role={failed ? "alert" : "status"}
            className="flex items-start gap-3 rounded-md border border-border/60 px-3 py-2 text-xs"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium">{host.label}</p>
              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                {status.detail ??
                  (failed
                    ? "Device support could not start."
                    : status.status === "installing"
                      ? "Installing device tools…"
                      : "Starting device tools…")}
              </p>
              {failed ? (
                <p className="mt-1 text-muted-foreground">
                  Check the host connection and network access, then retry. Your device settings are
                  saved.
                </p>
              ) : null}
            </div>
            {failed && state.supportsHostRetry ? (
              <Button
                size="compact"
                variant="outline"
                disabled={pending !== null}
                onClick={() => {
                  setPending(host.id);
                  void retry({ environmentId, input: { retryHostId: host.id } }).finally(() =>
                    setPending(null),
                  );
                }}
              >
                {pending === host.id ? "Retrying…" : "Retry"}
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

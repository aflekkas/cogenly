import { DeviceHostUpdates, deviceHostUpdateShown } from "./DeviceHostUpdates";
import type { DevicePlatform, DeviceServiceState, EnvironmentId } from "@cogenly/contracts";
import { Check } from "lucide-react";
import { Check as CheckGlyph, CircleAlert } from "lucide";
import { AuthSettingsWriteScope } from "@cogenly/contracts";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { DialogClose } from "~/components/ui/dialog";
import { MorphIcon } from "~/components/MorphIcon";
import { WizardHeader, WizardPanel, WizardFooter } from "~/components/ui/wizard";
import { Spinner } from "~/components/ui/spinner";
import { deviceEnvironment } from "~/state/device";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentScope } from "~/state/session";
import { cn } from "~/lib/utils";

const platformName = (platform: DevicePlatform) => (platform === "ios" ? "iOS" : "Android");

export const deviceHubDescription =
  "Enable this machine to open simulators and emulators, whether they run here or on a remote device host.";
export const agentDeviceDescription =
  "Allow new agent sessions on this machine to start and control local and remote devices, with required tools set up automatically.";

/**
 * `hostStatus` only tracks this machine. A machine without simulator tooling never
 * starts its own hub, so setup and the panel must also count remote device hosts.
 */
export function deviceHubReadiness(state: DeviceServiceState) {
  const statuses = Object.values(state.hostStatuses).map((host) => host.status);
  const ready = state.hostStatus === "ready" || statuses.includes("ready");
  const busy =
    !ready &&
    [state.hostStatus, ...statuses].some(
      (status) => status === "installing" || status === "starting",
    );
  return { ready, busy };
}

export function platformSetupStatus(state: DeviceServiceState, platform: DevicePlatform) {
  const availabilities = state.hosts.flatMap((host) =>
    host.platforms
      .filter((candidate) => candidate.platform === platform)
      .map((candidate) => ({ ...candidate, host })),
  );
  const supportingHosts = availabilities
    .filter((candidate) => candidate.available)
    .map((candidate) => candidate.host);
  if (supportingHosts.length === 0) {
    return {
      ready: false,
      message: availabilities[0]?.reason ?? `${platformName(platform)} support was not detected.`,
    };
  }
  const readyHosts = supportingHosts.filter(
    (host) =>
      state.hostStatuses[host.id]?.status === "ready" ||
      (host.kind === "local" && state.hostStatus === "ready"),
  );
  if (readyHosts.length > 0 && !state.devices.some((device) => device.platform === platform)) {
    return {
      ready: false,
      message:
        platform === "ios"
          ? "Xcode is installed, but no iOS Simulator is available. Install a runtime in Xcode Settings → Components."
          : "The Android SDK is installed, but no virtual device exists. Create one in Android Studio → Device Manager.",
    };
  }
  const remoteHost = supportingHosts.every((host) => host.kind !== "local")
    ? supportingHosts[0]
    : undefined;
  const location = remoteHost ? ` on ${remoteHost.label}` : "";
  return {
    ready: true,
    message:
      platform === "ios"
        ? `Xcode and iOS Simulator are available${location}.`
        : `The Android SDK and Emulator are available${location}.`,
  };
}

/**
 * Status and troubleshooting for device support: what is installed, whether
 * each platform works, and a way to retry. Nothing here gates using devices;
 * installs start by themselves the first time a device is needed.
 */
export function DeviceSetup(props: {
  readonly environmentId: EnvironmentId;
  readonly state: DeviceServiceState;
}) {
  const canConfigure = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const configure = useAtomCommand(deviceEnvironment.configure);
  const list = useAtomCommand(deviceEnvironment.list, { reportFailure: false });
  const [pending, setPending] = useState<"enable" | "check" | null>(null);
  const enabled = props.state.hostStatus !== "disabled";
  const { ready, busy } = deviceHubReadiness(props.state);

  // Remote hosts report platforms only after a probe, like the Device panel's refresh on open.
  useEffect(() => {
    if (enabled) void list({ environmentId: props.environmentId, input: {} });
  }, [enabled, list, props.environmentId]);

  return (
    <>
      <WizardHeader
        title="Device setup"
        description="What device support has installed on this machine, and what each platform needs."
      />

      <WizardPanel>
        <div className="flex flex-col gap-5">
          <section className="space-y-3 text-sm">
            <h3 className="font-medium">Device hub</h3>
            {enabled ? (
              deviceHostUpdateShown(props.state) ? (
                <DeviceHostUpdates state={props.state} environmentId={props.environmentId} />
              ) : (
                <>
                  <DeviceHubSetupStatus state={props.state} pending={busy} />
                  {!ready && !busy ? (
                    <p className="text-xs text-muted-foreground">
                      Device support installs itself the first time a device is needed.
                    </p>
                  ) : null}
                </>
              )
            ) : (
              <div className="flex items-start justify-between gap-4">
                <p className="text-muted-foreground">
                  Device support is turned off for this machine.
                </p>
                <Button
                  size="compact"
                  variant="outline"
                  disabled={!canConfigure || pending !== null}
                  busy={pending === "enable"}
                  onClick={() => {
                    setPending("enable");
                    void configure({
                      environmentId: props.environmentId,
                      input: { enabled: true },
                    }).finally(() => setPending(null));
                  }}
                >
                  {pending === "enable" ? "Turning on…" : "Turn on"}
                </Button>
              </div>
            )}
          </section>

          {enabled ? (
            <>
              <section className="space-y-3 text-sm">
                <h3 className="font-medium">Simulator support</h3>
                <DevicePlatformSetup
                  state={props.state}
                  checking={pending === "check"}
                  disabled={busy || pending !== null}
                  onCheck={() => {
                    setPending("check");
                    void list({ environmentId: props.environmentId, input: {} }).finally(() =>
                      setPending(null),
                    );
                  }}
                />
              </section>

              <section className="space-y-3 text-sm">
                <h3 className="font-medium">Agent access</h3>
                <p className="text-muted-foreground">
                  {props.state.agentAccessEnabled
                    ? "New agent sessions can start and control devices, with required tools set up automatically."
                    : "Agents cannot use devices. Turn this on in Settings → Integrations → Devices."}
                </p>
                <AgentDeviceSetupStatus state={props.state} pending={false} />
              </section>
            </>
          ) : null}
          {props.state.hostStatus === "failed" && props.state.hostStatusDetail ? (
            <p role="alert" className="text-xs text-destructive">
              {props.state.hostStatusDetail}
            </p>
          ) : null}
        </div>
      </WizardPanel>

      <WizardFooter>
        <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
      </WizardFooter>
    </>
  );
}

export function DeviceHubSetupStatus({
  state,
  pending,
  compact = false,
}: {
  readonly state: DeviceServiceState;
  readonly pending: boolean;
  readonly compact?: boolean;
}) {
  if (!pending && !deviceHubReadiness(state).ready) return null;
  return (
    <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
      {pending ? <Spinner size="xs" /> : <Check className="size-3 text-success" />}
      {pending
        ? state.hostStatus === "installing"
          ? compact
            ? "Installing…"
            : "Installing device hub…"
          : state.hostStatus === "starting"
            ? compact
              ? "Starting…"
              : "Starting device hub…"
            : compact
              ? "Updating…"
              : "Updating device hub…"
        : "Device hub is ready."}
    </p>
  );
}

function DevicePlatformSetup(props: {
  readonly state: DeviceServiceState;
  readonly checking: boolean;
  readonly disabled: boolean;
  readonly onCheck: () => void;
}) {
  return (
    <div className="space-y-3">
      <PlatformStatus platform="iOS" status={platformSetupStatus(props.state, "ios")} />
      <PlatformStatus platform="Android" status={platformSetupStatus(props.state, "android")} />
      <p className="text-xs text-muted-foreground">
        You can use either platform. Fixing a missing platform does not block the other one.
      </p>
      <Button
        size="compact"
        variant="outline"
        disabled={props.disabled}
        busy={props.checking}
        onClick={props.onCheck}
      >
        {props.checking ? <Spinner size="xs" /> : null}
        {props.checking ? "Checking…" : "Check again"}
      </Button>
    </div>
  );
}

export function AgentDeviceSetupStatus(props: {
  readonly state: DeviceServiceState;
  readonly pending: boolean;
  readonly compact?: boolean;
}) {
  if (props.pending) {
    const label =
      props.state.hostStatus === "installing"
        ? props.compact
          ? "Installing…"
          : "Installing agent tools…"
        : props.state.hostStatus === "starting"
          ? props.compact
            ? "Starting…"
            : "Starting agent tools…"
          : props.compact
            ? "Updating…"
            : "Updating agent access…";
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner size="xs" />
        {label}
      </p>
    );
  }
  if (
    props.state.agentAccessEnabled &&
    deviceHubReadiness(props.state).ready &&
    props.state.hosts.some((host) => host.agentDeviceInstalled)
  ) {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Check className="size-3 text-success" />
        Agent tools are ready.
      </p>
    );
  }
  return null;
}

export function PlatformStatus(props: {
  readonly platform: string;
  readonly status: { readonly ready: boolean; readonly message: string };
  readonly compact?: boolean;
  /** What a compact ready row says. Defaults to "Ready". */
  readonly readyLabel?: string;
}) {
  return (
    <div
      className={cn("flex gap-2", !props.compact && "rounded-md border border-border/60 px-3 py-2")}
    >
      <MorphIcon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          props.status.ready ? "text-success" : "text-muted-foreground",
        )}
        icon={props.status.ready ? CheckGlyph : CircleAlert}
      />
      <div className={cn(props.compact && props.status.ready && "flex items-center gap-2")}>
        <p className="text-sm font-medium text-foreground">{props.platform}</p>
        <p className="text-xs text-muted-foreground">
          {props.compact && props.status.ready
            ? (props.readyLabel ?? "Ready")
            : props.status.message}
        </p>
      </div>
    </div>
  );
}

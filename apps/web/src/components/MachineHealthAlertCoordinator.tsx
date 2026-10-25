import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MachineHealthAlertsSnapshot } from "@cogenly/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useStableCallback } from "../hooks/useStableCallback";
import {
  healthAlertGroupKey,
  mergeHealthAlertSnapshots,
  parseSeenHealthAlertIds,
  planHealthAlertNotifications,
  rememberSeenHealthAlertIds,
  worstHealthStatus,
  type MergedHealthAlert,
} from "../machines/machineHealthAlerts.logic";
import { useMachineHealthAlertStore } from "../machines/machineHealthAlertsStore";
import { healthAlertActions } from "../machines/machineHealthLinks.logic";
import {
  machineHealthActionPermissionAtom,
  useRunMachineHealthAction,
} from "../machines/useRunMachineHealthAction";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { machinesRpc } from "../rpc/machines";
import { useConnectedEnvironmentIds, useEnvironmentIds } from "../state/environments";
import {
  hasNotificationSound,
  playNotificationSound,
  showBackgroundNotification,
} from "../threadNotifications";
import { toastManager } from "./ui/toast";

const SEEN_STORAGE_KEY = "cogenly:machine-health:seen-alerts:v1";

function readSeenAlertIds(): string[] {
  try {
    return parseSeenHealthAlertIds(localStorage.getItem(SEEN_STORAGE_KEY));
  } catch {
    return [];
  }
}

function writeSeenAlertIds(ids: ReadonlyArray<string>) {
  try {
    localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* Seen ids still hold for this session. */
  }
}

interface ShownAlert {
  readonly toastId: string;
  readonly notification: Notification | null;
}

/**
 * Machine health alerts on every client: one stream per connected server,
 * deduped by alert id, a toast (and a desktop notification in the
 * background) once per alert, and the Settings dot while any is open.
 * Ids this device toasted persist, so a reload or reconnect stays quiet.
 */
export function MachineHealthAlertCoordinator() {
  const environmentIds = useEnvironmentIds();
  const connectedIds = useConnectedEnvironmentIds();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const runAction = useRunMachineHealthAction();
  const setWorstOpenStatus = useMachineHealthAlertStore((store) => store.setWorstOpenStatus);
  const snapshots = useRef(new Map<EnvironmentId, MachineHealthAlertsSnapshot>());
  const seen = useRef<string[] | null>(null);
  // Keyed by healthAlertGroupKey: one toast per problem, whichever server's id it came under.
  const shown = useRef(new Map<string, ShownAlert>());

  const present = (entry: MergedHealthAlert, connected: ReadonlySet<EnvironmentId>): ShownAlert => {
    const { alert } = entry;
    const { primary, secondary } = healthAlertActions(
      alert,
      { viaEnvironmentId: entry.via, isConnected: (id) => connected.has(id) },
      (action) => appAtomRegistry.get(machineHealthActionPermissionAtom(action)),
    );
    const description = alert.detail.trim()
      ? `${alert.originMachineName}: ${alert.detail}`
      : alert.originMachineName;
    const toastId = toastManager.add({
      type: alert.status === "fail" ? "error" : "warning",
      title: alert.title,
      description,
      // Stays until dismissed or the problem clears; it is the alert.
      timeout: 0,
      data: {
        hideCopyButton: true,
        ...(secondary === null
          ? {}
          : {
              secondaryActionProps: {
                children: secondary.label,
                onClick: () => {
                  toastManager.close(toastId);
                  void runAction(secondary);
                },
              },
            }),
      },
      actionProps: {
        children: primary.label,
        onClick: () => {
          toastManager.close(toastId);
          void runAction(primary);
        },
      },
    });
    // A click on the notification only opens a screen; it never runs a command.
    const opener = primary.kind === "open" ? primary : (secondary ?? primary);
    const notification = showBackgroundNotification(mode, {
      title: alert.title,
      body: description,
      tag: `machine-health:${alert.id}`,
      onClick: () => {
        toastManager.close(toastId);
        if (opener.kind === "open") void runAction(opener);
      },
    });
    return { toastId, notification };
  };

  const reconcile = useStableCallback(() => {
    const merged = mergeHealthAlertSnapshots(snapshots.current);
    setWorstOpenStatus(worstHealthStatus(merged.open.map(({ alert }) => alert.status)));
    seen.current ??= readSeenAlertIds();
    const plan = planHealthAlertNotifications(
      merged,
      new Set(seen.current),
      new Set(shown.current.keys()),
    );
    for (const { alert } of plan.retract) {
      const key = healthAlertGroupKey(alert);
      const entry = shown.current.get(key);
      shown.current.delete(key);
      if (entry === undefined) continue;
      toastManager.close(entry.toastId);
      entry.notification?.close();
      toastManager.add({
        type: "success",
        title: `Resolved on ${alert.originMachineName}`,
        description: alert.title,
      });
    }
    if (plan.toast.length > 0) {
      const connected = new Set(connectedIds);
      for (const entry of plan.toast) {
        shown.current.set(healthAlertGroupKey(entry.alert), present(entry, connected));
      }
      if (hasNotificationSound(mode)) {
        void playNotificationSound("input", () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }
    }
    if (plan.remember.length === 0) return;
    seen.current = rememberSeenHealthAlertIds(
      seen.current,
      plan.remember,
      new Set(merged.open.flatMap(({ ids }) => ids)),
    );
    writeSeenAlertIds(seen.current);
  });

  const onSnapshot = useStableCallback(
    (environmentId: EnvironmentId, snapshot: MachineHealthAlertsSnapshot | null) => {
      if (snapshot === null) snapshots.current.delete(environmentId);
      else snapshots.current.set(environmentId, snapshot);
      reconcile();
    },
  );

  // The dot belongs to this coordinator's view; clear it when it goes away.
  useEffect(() => () => setWorstOpenStatus(null), [setWorstOpenStatus]);

  return environmentIds.map((environmentId) => (
    <EnvironmentHealthAlerts
      key={environmentId}
      environmentId={environmentId}
      onSnapshot={onSnapshot}
    />
  ));
}

function EnvironmentHealthAlerts({
  environmentId,
  onSnapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly onSnapshot: (
    environmentId: EnvironmentId,
    snapshot: MachineHealthAlertsSnapshot | null,
  ) => void;
}) {
  const result = useAtomValue(machinesRpc.healthAlerts({ environmentId, input: {} }));
  const snapshot = Option.getOrNull(AsyncResult.value(result));
  useEffect(() => {
    if (snapshot !== null) onSnapshot(environmentId, snapshot);
  }, [environmentId, onSnapshot, snapshot]);
  useEffect(() => () => onSnapshot(environmentId, null), [environmentId, onSnapshot]);
  return null;
}

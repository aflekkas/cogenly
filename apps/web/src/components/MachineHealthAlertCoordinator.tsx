import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MachineHealthAlertsSnapshot } from "@cogenly/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useStableCallback } from "../hooks/useStableCallback";
import {
  healthAlertGroupKey,
  healthAlertGroupView,
  healthAlertProblems,
  mergeHealthAlertSnapshots,
  parseQuietHealthProblems,
  parseSeenHealthAlertIds,
  planHealthAlertNotifications,
  rememberSeenHealthAlertIds,
  type MergedHealthAlert,
  type QuietHealthProblems,
} from "../machines/machineHealthAlerts.logic";
import { useMachineHealthAlertStore } from "../machines/machineHealthAlertsStore";
import {
  healthFixAction,
  healthTurnOffProviderAction,
  labelSignIn,
  machineHealthLink,
  type MachineHealthAction,
} from "../machines/machineHealthLinks.logic";
import {
  machineHealthActionPermissionAtom,
  useRunMachineHealthAction,
} from "../machines/useRunMachineHealthAction";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { machinesRpc } from "../rpc/machines";
import {
  readEnvironmentSupportsHealthFix,
  readEnvironmentSupportsTurnOffProvider,
} from "../state/entities";
import { useConnectedEnvironmentIds, useEnvironmentIds } from "../state/environments";
import {
  hasNotificationSound,
  playNotificationSound,
  showBackgroundNotification,
} from "../threadNotifications";
import { toastManager } from "./ui/toast";

const SEEN_STORAGE_KEY = "cogenly:machine-health:seen-alerts:v1";
const QUIET_STORAGE_KEY = "cogenly:machine-health:quiet-problems:v1";

function readQuietProblems(): Map<string, number> {
  try {
    return parseQuietHealthProblems(localStorage.getItem(QUIET_STORAGE_KEY));
  } catch {
    return new Map();
  }
}

function writeQuietProblems(quiet: QuietHealthProblems) {
  try {
    localStorage.setItem(QUIET_STORAGE_KEY, JSON.stringify(Object.fromEntries(quiet)));
  } catch {
    /* Quiet problems still hold for this session. */
  }
}

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
  /** What the toast says now, so a grown count updates it in place. */
  readonly signature: string;
}

/**
 * Machine health alerts on every client: one stream per connected server,
 * deduped by alert id, one toast (and a desktop notification in the
 * background) per machine and problem kind with a count, and the Settings dot
 * while any is open. Ids this device toasted persist, so a reload or
 * reconnect stays quiet, and so do problems that wait for the owner (a
 * sign-in): they pop up once, then stay in the machine's health until their
 * status changes.
 */
export function MachineHealthAlertCoordinator() {
  const environmentIds = useEnvironmentIds();
  const connectedIds = useConnectedEnvironmentIds();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const runAction = useRunMachineHealthAction();
  const setOpenAlerts = useMachineHealthAlertStore((store) => store.setOpenAlerts);
  const snapshots = useRef(new Map<EnvironmentId, MachineHealthAlertsSnapshot>());
  const seen = useRef<string[] | null>(null);
  const quiet = useRef<QuietHealthProblems | null>(null);
  // Keyed by healthAlertGroupKey: one toast per machine and check, whichever server it came from.
  const shown = useRef(new Map<string, ShownAlert>());

  /**
   * The toast's content: one Fix (Sign in when that is all it does), Turn off
   * for a provider that isn't signed in there, the X, and the title opening
   * Settings → Machines health.
   */
  const toastContent = (
    entry: MergedHealthAlert,
    connected: ReadonlySet<EnvironmentId>,
    toastId: () => string,
  ) => {
    const { alert } = entry;
    const view = healthAlertGroupView(entry);
    const context = {
      originEnvironmentId: alert.originEnvironmentId,
      originMachineName: alert.originMachineName,
      viaEnvironmentId: entry.via,
      isConnected: (id: EnvironmentId) => connected.has(id),
      supportsHealthFix: readEnvironmentSupportsHealthFix,
      supportsTurnOffProvider: readEnvironmentSupportsTurnOffProvider,
    };
    const details: MachineHealthAction = {
      kind: "open",
      label: "Details",
      link: machineHealthLink(alert.originEnvironmentId, context),
    };
    const problems = healthAlertProblems(entry);
    const permitted = (action: MachineHealthAction | null) =>
      action !== null && appAtomRegistry.get(machineHealthActionPermissionAtom(action))
        ? action
        : null;
    const primary = permitted(labelSignIn(healthFixAction(problems, context)));
    const turnOff = permitted(healthTurnOffProviderAction(problems, context));
    const openDetails = () => {
      toastManager.close(toastId());
      void runAction(details);
    };
    const failing = view.status === "fail";
    return {
      view,
      details,
      content: {
        type: failing ? ("error" as const) : ("warning" as const),
        title: (
          <button
            type="button"
            className="text-start hover:underline focus-visible:underline focus-visible:outline-none"
            onClick={openDetails}
          >
            {view.title}
          </button>
        ),
        description: view.description,
        data: {
          hideCopyButton: true,
          ...(turnOff === null
            ? {}
            : {
                secondaryActionProps: {
                  children: turnOff.label,
                  onClick: () => {
                    toastManager.close(toastId());
                    void runAction(turnOff);
                  },
                },
              }),
        },
        ...(primary === null
          ? {}
          : {
              actionProps: {
                children: primary.label,
                onClick: () => {
                  toastManager.close(toastId());
                  void runAction(primary);
                },
              },
            }),
      },
    };
  };

  const present = (entry: MergedHealthAlert, connected: ReadonlySet<EnvironmentId>): ShownAlert => {
    let toastId = "";
    const key = healthAlertGroupKey(entry.alert);
    const { view, details, content } = toastContent(entry, connected, () => toastId);
    toastId = toastManager.add({
      ...content,
      // A failure stays until dismissed or it clears; a warning leaves after the
      // usual time. Settings → Machines and the nav-rail dot keep showing both.
      ...(view.status === "fail" ? { timeout: 0 } : {}),
      // Closed by X, Fix or its timeout: the group's items stay seen, and the
      // next new one shows a fresh toast instead of updating this closed one.
      onClose: () => {
        if (shown.current.get(key)?.toastId === toastId) shown.current.delete(key);
      },
    });
    // A click on the notification only opens a screen; it never runs a command.
    const notification = showBackgroundNotification(mode, {
      title: view.title,
      body: view.description,
      tag: `machine-health:${healthAlertGroupKey(entry.alert)}`,
      onClick: () => {
        toastManager.close(toastId);
        void runAction(details);
      },
    });
    return { toastId, notification, signature: JSON.stringify(view) };
  };

  /** A shown group whose count or titles changed says so in place, without a new toast. */
  const refresh = (
    entry: MergedHealthAlert,
    current: ShownAlert,
    connected: ReadonlySet<EnvironmentId>,
  ): ShownAlert => {
    const signature = JSON.stringify(healthAlertGroupView(entry));
    if (signature === current.signature) return current;
    const { view, content } = toastContent(entry, connected, () => current.toastId);
    // A warning that escalates to a failure stays, like one that opened failing.
    toastManager.update(current.toastId, {
      ...content,
      ...(view.status === "fail" ? { timeout: 0 } : {}),
    });
    return { ...current, signature };
  };

  const reconcile = useStableCallback(() => {
    const merged = mergeHealthAlertSnapshots(snapshots.current);
    setOpenAlerts(merged.open.map(({ alert }) => alert));
    seen.current ??= readSeenAlertIds();
    quiet.current ??= readQuietProblems();
    const plan = planHealthAlertNotifications(
      merged,
      new Set(seen.current),
      new Set(shown.current.keys()),
      quiet.current,
      Date.now(),
    );
    quiet.current = plan.quiet;
    writeQuietProblems(plan.quiet);
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
    const connected = new Set(connectedIds);
    for (const entry of merged.open) {
      const key = healthAlertGroupKey(entry.alert);
      const current = shown.current.get(key);
      if (current !== undefined) shown.current.set(key, refresh(entry, current, connected));
    }
    if (plan.toast.length > 0) {
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
      new Set(merged.open.flatMap(({ seenKeys }) => seenKeys)),
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
  useEffect(() => () => setOpenAlerts([]), [setOpenAlerts]);

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

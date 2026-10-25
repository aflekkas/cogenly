import type {
  EnvironmentId,
  MachineHealthFix,
  MachineHealthTarget,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Where a health item or alert leads, and what its fix does. Settings →
 * Machines and the alert toasts both read these, so an item and its alert
 * always offer the same thing.
 */

/** A screen a health item points at. */
export type MachineHealthLink =
  | {
      readonly kind: "thread";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }
  | {
      readonly kind: "scheduledTask";
      readonly environmentId: EnvironmentId;
      readonly taskId: ScheduledTaskId;
    }
  | {
      readonly kind: "provider";
      readonly environmentId: EnvironmentId;
      readonly instanceId: ProviderInstanceId;
    }
  | { readonly kind: "integrations"; readonly environmentId: EnvironmentId }
  | {
      /** Settings → Machines as `viewedEnvironmentId` sees it, at `machineEnvironmentId`'s health. */
      readonly kind: "machineHealth";
      readonly viewedEnvironmentId: EnvironmentId;
      readonly machineEnvironmentId: EnvironmentId;
    };

export type MachineHealthAction =
  | { readonly kind: "open"; readonly label: string; readonly link: MachineHealthLink }
  | {
      readonly kind: "runTask";
      readonly label: string;
      readonly environmentId: EnvironmentId;
      readonly taskId: ScheduledTaskId;
    }
  | {
      /** Sent to `environmentId`, retrying its sync with `peerEnvironmentId`. */
      readonly kind: "retrySync";
      readonly label: string;
      readonly environmentId: EnvironmentId;
      readonly peerEnvironmentId: EnvironmentId;
    };

export interface MachineHealthActionContext {
  /** The machine the item is on. Its threads, tasks, providers and integrations live there. */
  readonly originEnvironmentId: EnvironmentId;
  /** The server this client read the item through: the origin, or a machine paired with it. */
  readonly viaEnvironmentId: EnvironmentId;
  /** Whether this client is connected to a server, so a command can be sent to it. */
  readonly isConnected: (environmentId: EnvironmentId) => boolean;
}

/** Element id of one machine's health section on Settings → Machines. */
export function machineHealthAnchorId(environmentId: EnvironmentId): string {
  return `machine-health-${environmentId}`;
}

/**
 * Which server's Settings → Machines to open for a machine's health: the
 * machine itself when this client reaches it, otherwise the server the item
 * came through, which reads that machine over the peer link.
 */
export function machineHealthViewer(
  machineEnvironmentId: EnvironmentId,
  context: Pick<MachineHealthActionContext, "viaEnvironmentId" | "isConnected">,
): EnvironmentId {
  return context.isConnected(machineEnvironmentId)
    ? machineEnvironmentId
    : context.viaEnvironmentId;
}

export function machineHealthLink(
  machineEnvironmentId: EnvironmentId,
  context: Pick<MachineHealthActionContext, "viaEnvironmentId" | "isConnected">,
): MachineHealthLink {
  return {
    kind: "machineHealth",
    viewedEnvironmentId: machineHealthViewer(machineEnvironmentId, context),
    machineEnvironmentId,
  };
}

const TARGET_LABELS = {
  thread: "Open thread",
  scheduledTask: "Open task",
  provider: "Open provider",
  integration: "Open integration",
  machine: "View machine",
} as const satisfies Record<MachineHealthTarget["_tag"], string>;

/** Opens the failing thing. */
export function healthTargetAction(
  target: MachineHealthTarget,
  context: MachineHealthActionContext,
): MachineHealthAction {
  const origin = context.originEnvironmentId;
  const label = TARGET_LABELS[target._tag];
  switch (target._tag) {
    case "thread":
      return {
        kind: "open",
        label,
        link: { kind: "thread", environmentId: origin, threadId: target.threadId },
      };
    case "scheduledTask":
      return {
        kind: "open",
        label,
        link: { kind: "scheduledTask", environmentId: origin, taskId: target.taskId },
      };
    case "provider":
      return {
        kind: "open",
        label,
        link: { kind: "provider", environmentId: origin, instanceId: target.instanceId },
      };
    case "integration":
      return { kind: "open", label, link: { kind: "integrations", environmentId: origin } };
    case "machine":
      return { kind: "open", label, link: machineHealthLink(target.environmentId, context) };
  }
}

/**
 * Sync is between two machines, so it can be retried from either side this
 * client reaches. The target names the other machine when the item has one;
 * otherwise the other side is the server the item came through.
 */
function retrySyncAction(
  target: MachineHealthTarget | null,
  context: MachineHealthActionContext,
): MachineHealthAction | null {
  const origin = context.originEnvironmentId;
  const peer =
    target?._tag === "machine" && target.environmentId !== origin
      ? target.environmentId
      : context.viaEnvironmentId !== origin
        ? context.viaEnvironmentId
        : null;
  if (peer === null) return null;
  const label = "Retry sync";
  if (context.isConnected(origin)) {
    return { kind: "retrySync", label, environmentId: origin, peerEnvironmentId: peer };
  }
  if (context.isConnected(peer)) {
    return { kind: "retrySync", label, environmentId: peer, peerEnvironmentId: origin };
  }
  return null;
}

/**
 * The one-click remedy, or null when there is none this client can offer:
 * a command needs a connection to the machine it runs on.
 */
export function healthFixAction(
  fix: MachineHealthFix | null,
  target: MachineHealthTarget | null,
  context: MachineHealthActionContext,
): MachineHealthAction | null {
  switch (fix) {
    case null:
      return null;
    case "sign-in":
      return target?._tag === "provider" || target?._tag === "integration"
        ? { ...healthTargetAction(target, context), label: "Sign in" }
        : null;
    case "run-now":
      return target?._tag === "scheduledTask" && context.isConnected(context.originEnvironmentId)
        ? {
            kind: "runTask",
            label: "Run now",
            environmentId: context.originEnvironmentId,
            taskId: target.taskId,
          }
        : null;
    case "resume":
      return target?._tag === "thread" ? healthTargetAction(target, context) : null;
    case "retry-sync":
      return retrySyncAction(target, context);
  }
}

/**
 * An alert toast's buttons. The primary is the first of fix, target and
 * "View health" this connection may use; "View health" rides along as the
 * secondary unless the primary already opens it.
 */
export function healthAlertActions(
  alert: {
    readonly originEnvironmentId: EnvironmentId;
    readonly fix: MachineHealthFix | null;
    readonly target: MachineHealthTarget | null;
  },
  context: Omit<MachineHealthActionContext, "originEnvironmentId">,
  isPermitted: (action: MachineHealthAction) => boolean,
): { readonly primary: MachineHealthAction; readonly secondary: MachineHealthAction | null } {
  const full = { ...context, originEnvironmentId: alert.originEnvironmentId };
  const viewHealth: MachineHealthAction = {
    kind: "open",
    label: "View health",
    link: machineHealthLink(alert.originEnvironmentId, full),
  };
  const candidates = [
    healthFixAction(alert.fix, alert.target, full),
    alert.target === null ? null : healthTargetAction(alert.target, full),
  ];
  const primary =
    candidates.find(
      (action): action is MachineHealthAction => action !== null && isPermitted(action),
    ) ?? viewHealth;
  const opensHealth =
    primary.kind === "open" &&
    primary.link.kind === "machineHealth" &&
    primary.link.machineEnvironmentId === alert.originEnvironmentId;
  return { primary, secondary: primary === viewHealth || opensHealth ? null : viewHealth };
}

/**
 * What an item offers: its fix first, then a link to its target unless the
 * fix already opens it.
 */
export function healthItemActions(
  item: { readonly fix: MachineHealthFix | null; readonly target: MachineHealthTarget | null },
  context: MachineHealthActionContext,
): { readonly fix: MachineHealthAction | null; readonly open: MachineHealthAction | null } {
  const fix = healthFixAction(item.fix, item.target, context);
  const open =
    item.target === null || fix?.kind === "open" ? null : healthTargetAction(item.target, context);
  return { fix, open };
}

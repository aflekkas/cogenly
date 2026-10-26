import type {
  EnvironmentId,
  MachineHealthCheckId,
  MachineHealthFix,
  MachineHealthTarget,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@cogenly/contracts";

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
  | { readonly kind: "storage"; readonly environmentId: EnvironmentId }
  | {
      /** Settings → Machines as `viewedEnvironmentId` sees it, at `machineEnvironmentId`'s health. */
      readonly kind: "machineHealth";
      readonly viewedEnvironmentId: EnvironmentId;
      readonly machineEnvironmentId: EnvironmentId;
    };

/** One health item, from a report or an alert, as Fix needs it. */
export interface MachineHealthProblem {
  readonly itemKey: string;
  readonly checkId: MachineHealthCheckId;
  readonly title: string;
  readonly detail: string;
  readonly fix: MachineHealthFix | null;
  readonly target: MachineHealthTarget | null;
}

/** A new chat that investigates problems with no direct fix, pre-filled with them. */
export interface MachineHealthAgentRequest {
  /** Where the chat opens: the origin machine when this client reaches it. */
  readonly environmentId: EnvironmentId;
  readonly prompt: string;
}

export type MachineHealthAction =
  | { readonly kind: "open"; readonly label: string; readonly link: MachineHealthLink }
  | {
      /**
       * `machines.healthFix` sent to `environmentId`, which runs it on the origin
       * (over the peer link when that is another machine). What comes back
       * `manual`, plus `rest`, goes to an agent.
       */
      readonly kind: "fix";
      readonly label: string;
      readonly environmentId: EnvironmentId;
      readonly originEnvironmentId: EnvironmentId;
      readonly itemKeys: readonly [string, ...Array<string>];
      readonly problems: ReadonlyArray<MachineHealthProblem>;
      readonly originMachineName: string;
    }
  | { readonly kind: "agent"; readonly label: string; readonly request: MachineHealthAgentRequest };

export interface MachineHealthActionContext {
  /** The machine the item is on. Its threads, tasks, providers and integrations live there. */
  readonly originEnvironmentId: EnvironmentId;
  readonly originMachineName: string;
  /** The server this client read the item through: the origin, or a machine paired with it. */
  readonly viaEnvironmentId: EnvironmentId;
  /** Whether this client is connected to a server, so a command can be sent to it. */
  readonly isConnected: (environmentId: EnvironmentId) => boolean;
}

/** Fixes the origin machine runs itself through `machines.healthFix`. */
const DIRECT_FIXES: ReadonlySet<MachineHealthFix> = new Set([
  "run-now",
  "resume",
  "stop-runs",
  "retry-sync",
  "setup-sandbox",
]);

const targetLine = (target: MachineHealthTarget | null): string | null => {
  switch (target?._tag) {
    case undefined:
    case "storage":
      return null;
    case "thread":
      return `thread ${target.threadId}`;
    case "scheduledTask":
      return `scheduled task ${target.taskId}`;
    case "provider":
      return `provider ${target.instanceId}`;
    case "integration":
      return `integration ${target.name}`;
    case "machine":
      return `machine ${target.environmentId}`;
  }
};

/**
 * The opening message of an agent asked to fix health problems: what is wrong
 * where, with the ids its tools take, and where to start.
 */
export function machineHealthAgentPrompt(
  problems: ReadonlyArray<MachineHealthProblem>,
  machine: {
    readonly environmentId: EnvironmentId;
    readonly name: string;
    /** False when the chat runs on another machine than the one with the problem. */
    readonly local: boolean;
  },
): string {
  const one = problems.length === 1;
  const lines = problems.map((problem) => {
    const context = [
      `check ${problem.checkId}`,
      `item ${problem.itemKey}`,
      targetLine(problem.target),
    ]
      .filter((part) => part !== null)
      .join(", ");
    const detail = problem.detail.trim();
    return `- ${problem.title}${detail.length > 0 ? `. ${detail}` : ""} (${context})`;
  });
  return [
    `Machine health on "${machine.name}" reports ${one ? "a problem" : `${problems.length} problems`} with no one-click fix. Investigate and fix ${one ? "it" : "them"}.`,
    "",
    ...lines,
    "",
    `Start with machine_health for environmentId ${machine.environmentId}${machine.local ? "" : ", read over the peer link from this machine"}, and use machine_health_fix for anything that has a direct fix. Tell me what you found and what you changed.`,
  ].join("\n");
}

/** The server a command goes to: the origin when connected, else the one the item came through. */
function commandEnvironment(context: MachineHealthActionContext): EnvironmentId | null {
  if (context.isConnected(context.originEnvironmentId)) return context.originEnvironmentId;
  return context.isConnected(context.viaEnvironmentId) ? context.viaEnvironmentId : null;
}

/** The agent request for problems Fix can't run directly, or null without a server to start it on. */
export function machineHealthAgentRequest(
  problems: ReadonlyArray<MachineHealthProblem>,
  context: MachineHealthActionContext,
): MachineHealthAgentRequest | null {
  const environmentId = commandEnvironment(context);
  if (environmentId === null || problems.length === 0) return null;
  return {
    environmentId,
    prompt: machineHealthAgentPrompt(problems, {
      environmentId: context.originEnvironmentId,
      name: context.originMachineName,
      local: environmentId === context.originEnvironmentId,
    }),
  };
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
  storage: "Open Storage",
} as const satisfies Record<MachineHealthTarget["_tag"], string>;

/** Opens the failing thing. */
export function healthTargetAction(
  target: MachineHealthTarget,
  context: MachineHealthActionContext,
): MachineHealthAction {
  const origin = context.originEnvironmentId;
  const label = TARGET_LABELS[target._tag];
  switch (target._tag) {
    case "storage":
      return { kind: "open", label, link: { kind: "storage", environmentId: origin } };
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
 * The one Fix for a problem or a group of them, or null when this client
 * reaches no server to run it on:
 * - items with a direct fix run it on their machine (`machines.healthFix`),
 *   and whatever is left goes to an agent afterwards;
 * - a sign-in opens the provider or integration sign-in, which needs the owner;
 * - anything else starts a chat with an agent, pre-filled with the problem.
 */
export function healthFixAction(
  problems: ReadonlyArray<MachineHealthProblem>,
  context: MachineHealthActionContext,
): MachineHealthAction | null {
  const [first] = problems;
  if (first === undefined) return null;
  const label = "Fix";
  const direct = problems.filter(
    (problem) => problem.fix !== null && DIRECT_FIXES.has(problem.fix),
  );
  const [firstKey, ...restKeys] = direct.map((problem) => problem.itemKey);
  if (firstKey !== undefined) {
    const environmentId = commandEnvironment(context);
    return environmentId === null
      ? null
      : {
          kind: "fix",
          label,
          environmentId,
          originEnvironmentId: context.originEnvironmentId,
          itemKeys: [firstKey, ...restKeys],
          problems,
          originMachineName: context.originMachineName,
        };
  }
  const signIn = first.target;
  if (
    problems.every((problem) => problem.fix === "sign-in") &&
    (signIn?._tag === "provider" || signIn?._tag === "integration")
  ) {
    return { ...healthTargetAction(signIn, context), label };
  }
  const request = machineHealthAgentRequest(problems, context);
  return request === null ? null : { kind: "agent", label, request };
}

/** What Fix leaves to an agent: the problems the origin returned `manual`, and those with no direct fix. */
export function problemsLeftForAgent(
  action: Extract<MachineHealthAction, { readonly kind: "fix" }>,
  manualItemKeys: ReadonlyArray<string>,
): ReadonlyArray<MachineHealthProblem> {
  const manual = new Set(manualItemKeys);
  const sent = new Set<string>(action.itemKeys);
  return action.problems.filter(
    (problem) => manual.has(problem.itemKey) || !sent.has(problem.itemKey),
  );
}

/**
 * What a Settings → Machines item offers: its Fix, then a link to the thing it
 * points at unless Fix already opens it.
 */
export function healthItemActions(
  problem: MachineHealthProblem,
  context: MachineHealthActionContext,
): { readonly fix: MachineHealthAction | null; readonly open: MachineHealthAction | null } {
  const fix = healthFixAction([problem], context);
  const open =
    problem.target === null || fix?.kind === "open"
      ? null
      : healthTargetAction(problem.target, context);
  return { fix, open };
}

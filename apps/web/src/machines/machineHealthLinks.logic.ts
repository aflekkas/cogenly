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

/** One item's fix as a server from before `machines.healthFix` (0.3.1 and earlier) runs it. */
export type MachineHealthLegacyCommand =
  | {
      readonly kind: "runTask";
      readonly itemKey: string;
      readonly environmentId: EnvironmentId;
      readonly taskId: ScheduledTaskId;
    }
  | {
      readonly kind: "retrySync";
      readonly itemKey: string;
      readonly environmentId: EnvironmentId;
      readonly peerEnvironmentId: EnvironmentId;
    }
  | {
      readonly kind: "setupSandbox";
      readonly itemKey: string;
      readonly environmentId: EnvironmentId;
    };

export type MachineHealthDirectFix =
  | {
      /**
       * `machines.healthFix` sent to `environmentId`, which runs it on the
       * origin (over the peer link when that is another machine).
       */
      readonly kind: "healthFix";
      readonly environmentId: EnvironmentId;
      readonly itemKeys: readonly [string, ...Array<string>];
    }
  | {
      /** The older per-item commands, for a server that doesn't advertise `machineHealthFix`. */
      readonly kind: "legacy";
      readonly commands: readonly [
        MachineHealthLegacyCommand,
        ...Array<MachineHealthLegacyCommand>,
      ];
    };

export type MachineHealthAction =
  | { readonly kind: "open"; readonly label: string; readonly link: MachineHealthLink }
  | {
      /**
       * Everything a group's Fix does, in order: run the direct fixes, then
       * open the first sign-in, or else hand what is left to an agent. The
       * rest stay listed on the machine's health, at `details`.
       */
      readonly kind: "fix";
      readonly label: string;
      readonly originEnvironmentId: EnvironmentId;
      readonly originMachineName: string;
      readonly direct: MachineHealthDirectFix | null;
      /** Sign-ins, which need the owner: Fix opens the first. */
      readonly signIns: ReadonlyArray<MachineHealthLink>;
      /** What an agent may get: items with no other route, and direct ones that come back `manual`. */
      readonly problems: ReadonlyArray<MachineHealthProblem>;
      /** Where that chat opens, or null when this client reaches no server to start it on. */
      readonly agentEnvironmentId: EnvironmentId | null;
      readonly details: MachineHealthLink;
    }
  | { readonly kind: "agent"; readonly label: string; readonly request: MachineHealthAgentRequest };

export type MachineHealthFixAction = Extract<MachineHealthAction, { readonly kind: "fix" }>;

export interface MachineHealthActionContext {
  /** The machine the item is on. Its threads, tasks, providers and integrations live there. */
  readonly originEnvironmentId: EnvironmentId;
  readonly originMachineName: string;
  /** The server this client read the item through: the origin, or a machine paired with it. */
  readonly viaEnvironmentId: EnvironmentId;
  /** Whether this client is connected to a server, so a command can be sent to it. */
  readonly isConnected: (environmentId: EnvironmentId) => boolean;
  /** Whether a server advertises `machineHealthFix`; older ones get their per-item commands. */
  readonly supportsHealthFix: (environmentId: EnvironmentId) => boolean;
}

/** Fixes the origin machine runs itself through `machines.healthFix`. */
const DIRECT_FIXES: ReadonlySet<MachineHealthFix> = new Set([
  "run-now",
  "resume",
  "stop-runs",
  "send-queue",
  "retry-sync",
  "setup-sandbox",
  "update-machine",
  "kill-orphans",
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
 * The command a pre-0.3.2 server runs for a direct fix, or null when it has
 * none this client can send. Sync is between two machines, so it can be
 * retried from either side this client reaches: the target names the other
 * machine when the item has one, otherwise it is the server the item came
 * through. Those servers can't stop stuck runs, so `stop-runs` gets the agent.
 */
function legacyHealthCommand(
  problem: MachineHealthProblem,
  context: MachineHealthActionContext,
): MachineHealthLegacyCommand | null {
  const origin = context.originEnvironmentId;
  const { itemKey, target } = problem;
  switch (problem.fix) {
    case "run-now":
      return target?._tag === "scheduledTask" && context.isConnected(origin)
        ? { kind: "runTask", itemKey, environmentId: origin, taskId: target.taskId }
        : null;
    case "setup-sandbox":
      return context.isConnected(origin)
        ? { kind: "setupSandbox", itemKey, environmentId: origin }
        : null;
    case "retry-sync": {
      // Quarantine is stored on the receiving machine. An older intermediary
      // can retry its own outgoing sync, but cannot replay the origin's held rows.
      if (itemKey.startsWith("sync:quarantined:") && !context.isConnected(origin)) return null;
      const peer =
        target?._tag === "machine" && target.environmentId !== origin
          ? target.environmentId
          : context.viaEnvironmentId !== origin
            ? context.viaEnvironmentId
            : null;
      if (peer === null) return null;
      if (context.isConnected(origin))
        return { kind: "retrySync", itemKey, environmentId: origin, peerEnvironmentId: peer };
      return context.isConnected(peer)
        ? { kind: "retrySync", itemKey, environmentId: peer, peerEnvironmentId: origin }
        : null;
    }
    default:
      return null;
  }
}

/** The provider or integration sign-in a `sign-in` item opens, or null when its target has none. */
function signInLink(
  problem: MachineHealthProblem,
  context: MachineHealthActionContext,
): MachineHealthLink | null {
  const { target } = problem;
  if (problem.fix !== "sign-in") return null;
  if (target?._tag !== "provider" && target?._tag !== "integration") return null;
  const action = healthTargetAction(target, context);
  return action.kind === "open" ? action.link : null;
}

/**
 * The one Fix for a problem or a group of them, or null when it has nothing
 * this client can do:
 * - items with a direct fix run it on their machine (`machines.healthFix`,
 *   or the older per-item command on a server without it);
 * - a sign-in opens the provider or integration sign-in, which needs the
 *   owner. Fix opens the first; each has its own Sign in on the machine's health;
 * - only items with neither start a chat with an agent, pre-filled with them.
 */
export function healthFixAction(
  problems: ReadonlyArray<MachineHealthProblem>,
  context: MachineHealthActionContext,
): MachineHealthAction | null {
  if (problems.length === 0) return null;
  const label = "Fix";
  const commandEnvironmentId = commandEnvironment(context);
  const legacy = commandEnvironmentId !== null && !context.supportsHealthFix(commandEnvironmentId);
  const directKeys: Array<string> = [];
  const legacyCommands: Array<MachineHealthLegacyCommand> = [];
  const signIns = new Map<string, MachineHealthLink>();
  const forAgent: Array<MachineHealthProblem> = [];
  for (const problem of problems) {
    if (commandEnvironmentId !== null && problem.fix !== null && DIRECT_FIXES.has(problem.fix)) {
      if (!legacy) {
        directKeys.push(problem.itemKey);
        // A direct fix that comes back manual goes to the agent.
        forAgent.push(problem);
        continue;
      }
      const command = legacyHealthCommand(problem, context);
      if (command !== null) {
        legacyCommands.push(command);
        continue;
      }
    }
    const link = signInLink(problem, context);
    // Two integrations sign in on the same screen; open it once.
    if (link !== null) signIns.set(JSON.stringify(link), link);
    else forAgent.push(problem);
  }
  const [firstKey, ...restKeys] = directKeys;
  const [firstCommand, ...restCommands] = legacyCommands;
  const direct: MachineHealthDirectFix | null =
    firstCommand !== undefined
      ? { kind: "legacy", commands: [firstCommand, ...restCommands] }
      : firstKey === undefined || commandEnvironmentId === null
        ? null
        : {
            kind: "healthFix",
            environmentId: commandEnvironmentId,
            itemKeys: [firstKey, ...restKeys],
          };
  const [onlySignIn, ...moreSignIns] = signIns.values();
  if (direct === null) {
    if (onlySignIn === undefined) {
      const request = machineHealthAgentRequest(forAgent, context);
      return request === null ? null : { kind: "agent", label, request };
    }
    if (moreSignIns.length === 0 && forAgent.length === 0) {
      return { kind: "open", label, link: onlySignIn };
    }
  }
  return {
    kind: "fix",
    label,
    originEnvironmentId: context.originEnvironmentId,
    originMachineName: context.originMachineName,
    direct,
    signIns: [...signIns.values()],
    problems: forAgent,
    agentEnvironmentId: commandEnvironmentId,
    details: machineHealthLink(context.originEnvironmentId, context),
  };
}

/** What Fix leaves to an agent: the problems the origin returned `manual`, and those with no direct fix. */
export function problemsLeftForAgent(
  action: MachineHealthFixAction,
  manualItemKeys: ReadonlyArray<string>,
): ReadonlyArray<MachineHealthProblem> {
  const manual = new Set(manualItemKeys);
  // Items sent as legacy commands never come back manual, so they aren't in `problems`.
  const sent = new Set<string>(action.direct?.kind === "healthFix" ? action.direct.itemKeys : []);
  return action.problems.filter(
    (problem) => manual.has(problem.itemKey) || !sent.has(problem.itemKey),
  );
}

/**
 * What a group's Fix does once its direct fixes ran: open the first sign-in,
 * or else start the agent on what is left. `remaining` counts what neither
 * reached, for a pointer to the machine's health where each has its own action.
 */
export function healthFixFollowUp(
  action: MachineHealthFixAction,
  manualItemKeys: ReadonlyArray<string>,
): {
  readonly signIn: MachineHealthLink | null;
  readonly agent: ReadonlyArray<MachineHealthProblem>;
  readonly remaining: number;
} {
  const left = problemsLeftForAgent(action, manualItemKeys);
  const [signIn, ...moreSignIns] = action.signIns;
  if (signIn !== undefined) {
    return { signIn, agent: [], remaining: moreSignIns.length + left.length };
  }
  return action.agentEnvironmentId === null
    ? { signIn: null, agent: [], remaining: left.length }
    : { signIn: null, agent: left, remaining: 0 };
}

/**
 * What a Settings → Machines item offers: its Fix, then a link to the thing it
 * points at unless Fix already opens it. A sign-in's Fix reads Sign in.
 */
export function healthItemActions(
  problem: MachineHealthProblem,
  context: MachineHealthActionContext,
): { readonly fix: MachineHealthAction | null; readonly open: MachineHealthAction | null } {
  const action = healthFixAction([problem], context);
  const fix = action?.kind === "open" ? { ...action, label: "Sign in" } : action;
  const open =
    problem.target === null || fix?.kind === "open"
      ? null
      : healthTargetAction(problem.target, context);
  return { fix, open };
}

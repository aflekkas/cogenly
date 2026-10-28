import type {
  EnvironmentId,
  MachineListResult,
  ProviderAuthInteraction,
  ProviderAuthState,
  ProviderInstanceId,
  ServerProviderAuthStatus,
} from "@cogenly/contracts";

/**
 * The guided provider sign-in: which machine a sign-in targets, and what the
 * flow shows at each step. Every step comes from the machine's real flow state
 * or a request this client has in flight, so no control claims progress that
 * is not happening.
 */

/** Where a sign-in runs and how the client reaches it. */
export interface ProviderSignInTarget {
  /** The server this client sends the sign-in commands to. */
  readonly environmentId: EnvironmentId;
  /** The paired machine that signs in, when it is not `environmentId` itself. */
  readonly targetEnvironmentId?: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly providerName: string;
  readonly machineName: string;
}

export interface ProviderMachineSignIn extends ProviderSignInTarget {
  readonly auth: ServerProviderAuthStatus;
  /** False for providers (such as Muse) that sign in outside Cogenly. */
  readonly canSignIn: boolean;
  readonly online: boolean;
  /** The machine this client is viewing; listed first. */
  readonly current: boolean;
}

/**
 * Each machine's sign-in for one provider, as `viaEnvironmentId`'s machine
 * list reports it: the `current` machine first, then the rest by name.
 * Machines without the provider are left out.
 */
export function providerMachineSignIns(input: {
  readonly viaEnvironmentId: EnvironmentId;
  readonly list: MachineListResult | null;
  readonly instanceId: ProviderInstanceId;
  /** The machine the user is looking at; defaults to the one `viaEnvironmentId` runs on. */
  readonly currentEnvironmentId?: EnvironmentId | null;
}): ReadonlyArray<ProviderMachineSignIn> {
  if (input.list === null) return [];
  const self = input.list.machines.find((machine) => machine.relation === "this");
  const current = input.currentEnvironmentId ?? self?.environmentId ?? null;
  return input.list.machines
    .flatMap((machine) => {
      const provider = machine.providers.find((entry) => entry.instanceId === input.instanceId);
      if (provider === undefined) return [];
      return [
        {
          environmentId: input.viaEnvironmentId,
          ...(machine.relation === "this" ? {} : { targetEnvironmentId: machine.environmentId }),
          instanceId: input.instanceId,
          providerName: provider.displayName,
          machineName: machine.name,
          auth: provider.auth,
          canSignIn: provider.canAuthenticate !== false,
          online: machine.online,
          current: machine.environmentId === current,
        } satisfies ProviderMachineSignIn,
      ];
    })
    .sort(
      (a, b) => Number(b.current) - Number(a.current) || a.machineName.localeCompare(b.machineName),
    );
}

/** The sign-in for the machine a thread runs on, or null when its list doesn't name it. */
export function providerSignInForMachine(input: {
  readonly viaEnvironmentId: EnvironmentId;
  readonly list: MachineListResult | null;
  readonly instanceId: ProviderInstanceId;
  /** The machine that runs the thread; null for `viaEnvironmentId` itself. */
  readonly machineEnvironmentId: EnvironmentId | null;
}): ProviderMachineSignIn | null {
  const entries = providerMachineSignIns({
    viaEnvironmentId: input.viaEnvironmentId,
    list: input.list,
    instanceId: input.instanceId,
    currentEnvironmentId: input.machineEnvironmentId,
  });
  return entries[0]?.current === true ? entries[0] : null;
}

/** The providers that need signing in on one machine (null: the one `viaEnvironmentId` runs on). */
export function providersNeedingSignIn(input: {
  readonly viaEnvironmentId: EnvironmentId;
  readonly list: MachineListResult | null;
  readonly machineEnvironmentId: EnvironmentId | null;
}): ReadonlyArray<ProviderMachineSignIn> {
  const machine = input.list?.machines.find((candidate) =>
    input.machineEnvironmentId === null
      ? candidate.relation === "this"
      : candidate.environmentId === input.machineEnvironmentId,
  );
  if (machine === undefined) return [];
  return machine.providers.flatMap((provider) => {
    const entry = providerSignInForMachine({
      viaEnvironmentId: input.viaEnvironmentId,
      list: input.list,
      instanceId: provider.instanceId as ProviderInstanceId,
      machineEnvironmentId: machine.environmentId,
    });
    return entry !== null && providerNeedsSignIn(entry) ? [entry] : [];
  });
}

/** Whether to offer Sign in: signed out on a machine that can sign in from here. */
export function providerNeedsSignIn(entry: ProviderMachineSignIn | null): boolean {
  return entry !== null && entry.auth === "unauthenticated" && entry.canSignIn && entry.online;
}

export const providerSignInTitle = (
  target: Pick<ProviderSignInTarget, "providerName" | "machineName">,
) => `Sign in to ${target.providerName} on ${target.machineName}`;

export const providerSignedOutLabel = (machineName: string) => `Not signed in on ${machineName}`;

/** What this client has in flight or learned outside the machine's flow state. */
export interface ProviderSignInLocal {
  /** The flow this client started; other flows' results are not this sign-in's. */
  readonly startedFlowId: string | null;
  /** A start request this client sent and has no answer for yet. */
  readonly starting: boolean;
  /** The interaction this client answered and the machine accepted, e.g. a submitted code. */
  readonly answeredInteraction: string | null;
  /** A response this client sent and has no answer for yet. */
  readonly responding: boolean;
  readonly cancelling: boolean;
  /** A command failure the machine's state does not show. */
  readonly error: string | null;
}

export const PROVIDER_SIGN_IN_LOCAL_INITIAL: ProviderSignInLocal = {
  startedFlowId: null,
  starting: false,
  answeredInteraction: null,
  responding: false,
  cancelling: false,
  error: null,
};

export type ProviderSignInStep =
  | { readonly kind: "loading" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "ready" }
  | { readonly kind: "choose-method"; readonly methods: NonNullable<ProviderAuthState["methods"]> }
  | { readonly kind: "starting" }
  /** Another client runs this machine's sign-in; this one can watch or cancel. */
  | { readonly kind: "elsewhere" }
  /** Claude: open the page, then paste the code it shows. */
  | {
      readonly kind: "code";
      readonly url: string | null;
      readonly interaction: Extract<ProviderAuthInteraction, { type: "credentials" }>;
      readonly submitting: boolean;
    }
  /** Codex: open the page and enter this code there; completes by itself. */
  | {
      readonly kind: "device-code";
      readonly url: string;
      readonly userCode: string;
    }
  | {
      readonly kind: "browser";
      readonly url: string;
      readonly interaction: Extract<ProviderAuthInteraction, { type: "browser" }> | null;
    }
  | {
      readonly kind: "terminal";
      readonly interaction: Extract<ProviderAuthInteraction, { type: "terminal" }>;
    }
  /** The machine is checking what the user did, including a code it accepted. */
  | { readonly kind: "verifying" }
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "cancelled" };

const ACTIVE_PHASES: ReadonlySet<ProviderAuthState["phase"]> = new Set([
  "starting",
  "waiting",
  "verifying",
]);

export const isProviderSignInActive = (step: ProviderSignInStep) =>
  step.kind === "starting" ||
  step.kind === "elsewhere" ||
  step.kind === "code" ||
  step.kind === "device-code" ||
  step.kind === "browser" ||
  step.kind === "terminal" ||
  step.kind === "verifying";

/** The step to show, from the machine's flow state and this client's own requests. */
export function providerSignInStep(input: {
  readonly auth: ProviderAuthState | undefined;
  readonly providerAuth: ServerProviderAuthStatus | undefined;
  readonly canSignIn: boolean;
  readonly local: ProviderSignInLocal;
}): ProviderSignInStep {
  const { auth, local } = input;
  const ours = auth?.flowId != null && auth.flowId === local.startedFlowId;
  if (!input.canSignIn) return { kind: "unsupported" };
  if (local.error !== null && !(auth && ACTIVE_PHASES.has(auth.phase) && ours))
    return { kind: "failed", message: local.error };
  if (local.starting) return { kind: "starting" };
  if (auth === undefined) return { kind: "loading" };
  // A paired machine's state arrives by polling, so it can trail the start that answered.
  if (
    local.startedFlowId !== null &&
    auth.flowId !== local.startedFlowId &&
    !ACTIVE_PHASES.has(auth.phase)
  )
    return { kind: "starting" };
  if (ACTIVE_PHASES.has(auth.phase)) {
    // Flow details are withheld from clients that did not start it.
    if (auth.flowId === null) return { kind: "elsewhere" };
    if (auth.phase === "starting") return { kind: "starting" };
    if (auth.phase === "verifying") return { kind: "verifying" };
    const interaction = auth.interaction ?? null;
    if (interaction?.type === "credentials") {
      if (local.answeredInteraction === `${auth.flowId}:${interaction.id}`)
        return { kind: "verifying" };
      return {
        kind: "code",
        url: interaction.url ?? auth.authorizationUrl,
        interaction,
        submitting: local.responding,
      };
    }
    if (interaction?.type === "deviceCode")
      return { kind: "device-code", url: interaction.url, userCode: interaction.userCode };
    if (interaction?.type === "terminal") return { kind: "terminal", interaction };
    if (interaction?.type === "browser")
      return { kind: "browser", url: interaction.url, interaction };
    if (auth.authorizationUrl)
      return { kind: "browser", url: auth.authorizationUrl, interaction: null };
    return { kind: "starting" };
  }
  // A finished flow speaks for this sign-in only when this client started it.
  if (ours && auth.phase === "succeeded") return { kind: "succeeded" };
  if (ours && auth.phase === "failed")
    return { kind: "failed", message: auth.message ?? "Sign-in failed. Try again." };
  if (ours && auth.phase === "cancelled") return { kind: "cancelled" };
  if (input.providerAuth === "authenticated" && local.startedFlowId === null)
    return { kind: "succeeded" };
  if ((auth.methods?.length ?? 0) > 1) return { kind: "choose-method", methods: auth.methods! };
  return { kind: "ready" };
}

/** Whether opening the flow should start signing in without another click. */
export function shouldAutoStartProviderSignIn(step: ProviderSignInStep): boolean {
  return step.kind === "ready";
}

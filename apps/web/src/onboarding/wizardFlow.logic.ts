import type { EnvironmentId, T3ImportStatus } from "@cogenly/contracts";

/**
 * Steps of the welcome wizard. `local` is the brief wait for this computer's
 * own connection before setup moves on to its agents; it has no stage of its own.
 */
export type OnboardingStep = "connection" | "local" | "agents" | "import";

/**
 * Where setup starts. A client served by a local server (desktop, `cogenly
 * serve`, dev) already has this computer registered as its primary
 * environment, so setup never asks the user to add or pick it; more computers
 * are added later in Settings → Connections. The hosted app has no local
 * server, so it starts by connecting a computer.
 */
export function resolveOnboardingStartStep(input: {
  readonly resumeEnvironmentId: EnvironmentId | undefined;
  readonly localAvailable: boolean;
  readonly localEnvironmentDisabled: boolean;
}): OnboardingStep {
  if (input.resumeEnvironmentId !== undefined) return "agents";
  return input.localAvailable && !input.localEnvironmentDisabled ? "local" : "connection";
}

export type LocalOnboardingSetup =
  | { readonly kind: "setup"; readonly environmentIds: readonly [EnvironmentId] }
  | { readonly kind: "wait" }
  | { readonly kind: "choose" };

/**
 * Setup targets only this computer. While its first connection settles the
 * wizard waits; a connection that failed falls back to choosing a computer.
 */
export function resolveLocalOnboardingSetup(
  primary: {
    readonly environmentId: EnvironmentId;
    readonly connection: { readonly phase: string };
  } | null,
): LocalOnboardingSetup {
  if (primary === null) return { kind: "wait" };
  switch (primary.connection.phase) {
    case "connected":
      return { kind: "setup", environmentIds: [primary.environmentId] };
    case "available":
    case "connecting":
    case "reconnecting":
      return { kind: "wait" };
    default:
      return { kind: "choose" };
  }
}

const STAGES_WITH_CONNECTION = ["Connect", "Agents", "Import"] as const;
const STAGES_LOCAL = ["Agents", "Import"] as const;

/** The progress bar's stages. Local setup has no connection stage. */
export function onboardingStages(includeConnection: boolean): ReadonlyArray<string> {
  return includeConnection ? STAGES_WITH_CONNECTION : STAGES_LOCAL;
}

export function onboardingStageIndex(step: OnboardingStep, includeConnection: boolean): number {
  const offset = includeConnection ? 1 : 0;
  switch (step) {
    case "connection":
    case "local":
      return 0;
    case "agents":
      return offset;
    case "import":
      return offset + 1;
  }
}

/** The step a click on an earlier stage returns to. */
export function onboardingStepAtStage(index: number, includeConnection: boolean): OnboardingStep {
  if (includeConnection && index === 0) return "connection";
  return index <= (includeConnection ? 1 : 0) ? "agents" : "import";
}

export type OnboardingT3Detection = "checking" | "found" | "absent";

/**
 * Whether the import step offers Import from T3 Code. Without permission or a
 * reachable importer the session import is the only path.
 */
export function detectT3ImportForOnboarding(input: {
  readonly canImport: boolean;
  readonly status: T3ImportStatus | null;
  readonly statusError: string | null;
}): OnboardingT3Detection {
  if (!input.canImport || input.statusError !== null) return "absent";
  if (input.status === null) return "checking";
  return input.status.source.available ? "found" : "absent";
}

export type OnboardingImportPath = "checking" | "t3" | "sessions";

/**
 * With T3 Code found, its importer is the import step: it brings the same
 * Claude and Codex conversations over with full history, and importing their
 * raw session files as well would list each one twice. The raw session import
 * stays reachable as an explicit secondary choice.
 */
export function resolveOnboardingImportPath(
  detection: OnboardingT3Detection,
  choice: "sessions" | null,
): OnboardingImportPath {
  if (choice === "sessions") return "sessions";
  switch (detection) {
    case "checking":
      return "checking";
    case "found":
      return "t3";
    case "absent":
      return "sessions";
  }
}

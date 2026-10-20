/**
 * Client-facing terminal policy.
 *
 * Users must not run their own commands: terminals exist to show agent runs.
 * These wrappers sit between the client RPC handlers in ws.ts and the
 * TerminalManager service. Internal callers (project setup scripts, the MCP
 * terminal toolkit via runAgent) keep using TerminalManager directly.
 *
 * @module ClientTerminals
 */
import * as Effect from "effect/Effect";
import {
  TerminalUserShellsDisabledError,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalError,
  type TerminalOpenInput,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  type TerminalWriteInput,
} from "@t3tools/contracts";

/**
 * Thread id the onboarding wizard opens provider setup terminals under.
 * Mirrors AGENT_ONBOARDING_THREAD_ID in apps/web WelcomeWizard.tsx.
 */
export const ONBOARDING_THREAD_ID = "onboarding-agent-setup";

/** Id prefix the onboarding wizard uses for provider setup terminals. */
export const ONBOARDING_TERMINAL_ID_PREFIX = "onboarding-";

/** Id prefix the server reserves for agent-run terminals (see runAgent). */
export const AGENT_TERMINAL_ID_PREFIX = "agent-";

/**
 * Whether a client open is the onboarding provider-login flow. The manager
 * still validates that the provider instance exists and resolves its
 * environment before spawning.
 */
export const isOnboardingTerminalOpen = (input: TerminalOpenInput): boolean =>
  input.threadId === ONBOARDING_THREAD_ID &&
  input.terminalId.startsWith(ONBOARDING_TERMINAL_ID_PREFIX) &&
  input.providerInstanceId !== undefined;

/**
 * Whether a client may type into a terminal. Agent runs may wait on
 * interactive input, and the onboarding login flow is interactive; every other
 * session (setup-script shells included) rejects client input.
 *
 * Prefixes are authoritative here because the server allocates them: agent-*
 * sessions only come from runAgent (plain open refuses those ids), and
 * non-agent sessions only come from onboarding-gated opens or internal
 * callers that never use these prefixes.
 */
export const isClientWritableTerminalId = (terminalId: string): boolean =>
  terminalId.startsWith(AGENT_TERMINAL_ID_PREFIX) ||
  terminalId.startsWith(ONBOARDING_TERMINAL_ID_PREFIX);

/**
 * Strip every spawn or respawn signal from a client attach. The runs view
 * sends cwd (and friends) alongside the ids, so those fields are ignored
 * rather than rejected; attach then only ever reaches an existing session.
 */
export const sanitizeClientAttachInput = (input: TerminalAttachInput): TerminalAttachInput => ({
  threadId: input.threadId,
  terminalId: input.terminalId,
  ...(input.cols !== undefined ? { cols: input.cols } : {}),
  ...(input.rows !== undefined ? { rows: input.rows } : {}),
});

const userShellsDisabled = (
  threadId: string,
  terminalId: string,
): Effect.Effect<never, TerminalUserShellsDisabledError> =>
  Effect.fail(new TerminalUserShellsDisabledError({ threadId, terminalId }));

/** Client open: onboarding provider setup only, never a user shell. */
export const openTerminalForClient = (
  open: (input: TerminalOpenInput) => Effect.Effect<TerminalSessionSnapshot, TerminalError>,
  input: TerminalOpenInput,
): Effect.Effect<TerminalSessionSnapshot, TerminalError> =>
  isOnboardingTerminalOpen(input)
    ? open(input)
    : userShellsDisabled(input.threadId, input.terminalId);

/** Client attach: existing sessions only, never spawn or respawn. */
export const attachTerminalForClient = (
  attachStream: (
    input: TerminalAttachInput,
    listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
  ) => Effect.Effect<() => void, TerminalError>,
  input: TerminalAttachInput,
  listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
): Effect.Effect<() => void, TerminalError> =>
  attachStream(sanitizeClientAttachInput(input), listener);

/** Client write: agent and onboarding sessions only. */
export const writeTerminalForClient = (
  write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>,
  input: TerminalWriteInput,
): Effect.Effect<void, TerminalError> =>
  isClientWritableTerminalId(input.terminalId)
    ? write(input)
    : userShellsDisabled(input.threadId, input.terminalId);

/**
 * Client restart: always rejected. Restarting an agent session is already an
 * error, and respawning any other session would mint a user shell.
 */
export const restartTerminalForClient = (
  input: TerminalRestartInput,
): Effect.Effect<TerminalSessionSnapshot, TerminalError> =>
  userShellsDisabled(input.threadId, input.terminalId);

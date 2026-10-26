import type {
  AgentPermissions,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  RuntimeMode,
  ProviderInteractionMode,
} from "@cogenly/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Whether this credential includes the "preview" capability. Adapters read
   * it to keep developer instructions truthful: when the user withholds agent
   * browser access, the prompt must not advertise `preview_*` tools that every
   * call would reject.
   */
  readonly browserToolsAvailable: boolean;
  /**
   * Whether this credential explicitly grants the Cogenly terminal tools.
   * Optional because a session can start with a credential that never stated
   * terminal availability (the shape a delegated child can start with);
   * consumers must treat an absent flag as "not granted"; see
   * {@link terminalToolsAvailable}.
   */
  readonly terminalToolsAvailable?: boolean;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities?: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/**
 * Whether the session explicitly offers terminal tools. Conversation turns
 * disable native shell execution independently; Work keeps its native shell
 * when this flag is absent. Prompt selection also checks the turn policy.
 */
export const terminalToolsAvailable = (
  config: Pick<McpProviderSessionConfig, "terminalToolsAvailable"> | undefined,
): boolean => config?.terminalToolsAvailable === true;

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

/** Shared prompt/execution policy. Callers re-read modes, settings and grants at execution. */
export function terminalLaunchPolicy(input: {
  readonly enabled: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly builderMode?: boolean | undefined;
  readonly chatMode?: boolean | undefined;
  readonly readOnlySandboxAvailable?: boolean | undefined;
  /** null/absent is an ordinary thread; an agent supplies its current grants. */
  readonly agentPermissions?: AgentPermissions | null | undefined;
}): "readOnlyLookup" | "unrestricted" | null {
  const authorized =
    input.enabled &&
    input.runtimeMode === "full-access" &&
    input.interactionMode === "default" &&
    input.builderMode !== true &&
    (input.agentPermissions == null ||
      (input.agentPermissions.read && input.agentPermissions.execute));
  if (!authorized) return null;
  // Persistent agents use the lookup sandbox unless every sensitive action is granted.
  const limitedAgent =
    input.agentPermissions != null &&
    !(["send", "create_pr", "merge", "deploy", "delete"] as const).every(
      (grant) => input.agentPermissions![grant],
    );
  if ((input.chatMode && input.agentPermissions == null) || limitedAgent)
    return input.readOnlySandboxAvailable === true ? "readOnlyLookup" : null;
  return "unrestricted";
}

export const terminalToolsAuthorized = (
  input: Parameters<typeof terminalLaunchPolicy>[0],
): boolean => terminalLaunchPolicy(input) !== null;

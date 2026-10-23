import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

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
   * consumers must treat an absent flag as "not granted" — see
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
 * Whether the Cogenly terminal tools are definitely available to this
 * session: an MCP session is present and its credential explicitly grants
 * terminal tools. Adapters disable the provider's native shell only when
 * this is true. A credential that never stated terminal availability
 * (`terminalToolsAvailable` undefined) keeps the native shell, so the agent
 * always has some way to run commands instead of none.
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

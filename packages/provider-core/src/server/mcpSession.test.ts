import {
  defaultAgentPermissions,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  terminalToolsAvailable,
  terminalToolsAuthorized,
  terminalLaunchPolicy,
  withAgentDeviceEnvironment,
  type McpProviderSessionConfig,
} from "./mcpSession.ts";

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});

describe("terminalToolsAvailable", () => {
  const config = (terminalToolsAvailableFlag?: boolean): McpProviderSessionConfig => ({
    environmentId: EnvironmentId.make("environment-terminal-test"),
    threadId: ThreadId.make("thread-terminal-test"),
    providerSessionId: "mcp-terminal-test",
    providerInstanceId: ProviderInstanceId.make("terminal-test"),
    endpoint: "http://127.0.0.1:1/mcp",
    authorizationHeader: "Bearer [REDACTED]",
    browserToolsAvailable: false,
    ...(terminalToolsAvailableFlag === undefined
      ? {}
      : { terminalToolsAvailable: terminalToolsAvailableFlag }),
  });

  it("counts terminal tools as available only on an explicit grant", () => {
    expect(terminalToolsAvailable(config(true))).toBe(true);
    expect(terminalToolsAvailable(config(false))).toBe(false);
    // A credential that never stated terminal availability keeps the native
    // shell: absent must not read as available.
    expect(terminalToolsAvailable(config())).toBe(false);
    expect(terminalToolsAvailable(undefined)).toBe(false);
  });
});

describe("terminalToolsAuthorized", () => {
  const base = { enabled: true, runtimeMode: "full-access", interactionMode: "default" } as const;
  it("withholds commands for plan, disabled and builder turns", () => {
    expect(terminalToolsAuthorized(base)).toBe(true);
    expect(terminalToolsAuthorized({ ...base, interactionMode: "plan" })).toBe(false);
    expect(terminalToolsAuthorized({ ...base, enabled: false })).toBe(false);
    expect(terminalToolsAuthorized({ ...base, builderMode: true })).toBe(false);
  });
  it("allows default agents in the sandbox and requires read and execute", () => {
    const input = {
      ...base,
      agentPermissions: defaultAgentPermissions,
      readOnlySandboxAvailable: true,
    };
    expect(terminalLaunchPolicy(input)).toBe("readOnlyLookup");
    expect(terminalToolsAuthorized({ ...input, readOnlySandboxAvailable: false })).toBe(false);
    for (const grant of ["read", "execute"] as const) {
      expect(
        terminalToolsAuthorized({
          ...input,
          agentPermissions: { ...defaultAgentPermissions, [grant]: false },
        }),
      ).toBe(false);
    }
  });
});

describe("terminal launch policy", () => {
  const base = { enabled: true, runtimeMode: "full-access", interactionMode: "default" } as const;
  it("fails closed for chats without a successful probe", () => {
    expect(terminalLaunchPolicy({ ...base, chatMode: true })).toBeNull();
    expect(
      terminalToolsAuthorized({ ...base, chatMode: true, readOnlySandboxAvailable: false }),
    ).toBe(false);
    expect(terminalLaunchPolicy({ ...base, chatMode: true, readOnlySandboxAvailable: true })).toBe(
      "readOnlyLookup",
    );
    expect(
      terminalLaunchPolicy({
        ...base,
        chatMode: true,
        readOnlySandboxAvailable: true,
        enabled: false,
      }),
    ).toBeNull();
  });
  it("keeps Work, scheduled Work and fully granted persistent agents unrestricted", () => {
    expect(terminalLaunchPolicy(base)).toBe("unrestricted");
    expect(
      terminalLaunchPolicy({ ...base, chatMode: false, readOnlySandboxAvailable: false }),
    ).toBe("unrestricted");
    expect(
      terminalLaunchPolicy({
        ...base,
        chatMode: true,
        agentPermissions: {
          ...defaultAgentPermissions,
          read: true,
          execute: true,
          send: true,
          create_pr: true,
          merge: true,
          deploy: true,
          delete: true,
        },
      }),
    ).toBe("unrestricted");
  });
});

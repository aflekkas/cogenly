/** SDK 1.4.6 SessionConfigExtensions admits only additive mcpServers. Unknown keys are ignored. */
export const museNativeMcpNotice = (useProviderConnectors?: boolean): string | undefined =>
  useProviderConnectors === true
    ? undefined
    : "\nMuse's current session protocol cannot suppress its configured native MCP servers. Cogenly integrations are attached, but native servers may also be visible. Use the Cogenly integration tools for connected services.\n";

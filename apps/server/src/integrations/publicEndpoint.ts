/** Only these conventional paths are known not to carry a bearer capability. */
export const isPublicIntegrationPath = (pathname: string): boolean =>
  ["/", "/mcp", "/sse", "/connect/mcp"].includes(pathname.replace(/\/+$/, "") || "/");

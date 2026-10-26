import { integrationCatalogEntryFor } from "@cogenly/contracts";

/** Only these conventional paths are known not to carry a bearer capability. */
export const isPublicIntegrationPath = (pathname: string): boolean =>
  ["/", "/mcp", "/sse"].includes(pathname);

/** A conventional path, or a catalog service's published endpoint such as Wispr Flow's /connect/mcp. */
export const isPublicIntegrationUrl = (url: URL): boolean =>
  isPublicIntegrationPath(url.pathname) ||
  (url.search === "" &&
    url.hash === "" &&
    integrationCatalogEntryFor({ transport: "http", url: url.href }) !== undefined);

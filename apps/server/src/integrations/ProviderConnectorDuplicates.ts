import {
  INTEGRATION_CATALOG,
  type IntegrationCatalogEntry,
  type IntegrationCatalogId,
} from "@t3tools/contracts";

/**
 * Provider-native connectors and MCP servers that duplicate a Cogenly catalog
 * service. Inside Cogenly the catalog is the single source for its services,
 * connected or not (an unconnected one is offered through integration_add),
 * so adapters keep these duplicates away from the agents they launch unless
 * the user turned on `useProviderConnectors`. Everything else the provider
 * brings stays.
 *
 * A duplicate is recognized by the service name a provider shows for it
 * (claude.ai connectors, ChatGPT apps in Codex) or by the origin of an HTTP
 * MCP server (plugin and user-configured servers). Local stdio servers have
 * neither, so they are left alone.
 */

/**
 * The names providers give each catalog service. Typed over every catalog id
 * so a new entry needs a decision here. `figma` is empty: Cogenly can't
 * connect it yet, so the provider's own Figma connector stays the only route.
 */
const PROVIDER_SERVICE_NAMES = {
  "google-workspace": [
    "Gmail",
    "Google Calendar",
    "Google Drive",
    "Google Docs",
    "Google Sheets",
    "Google Slides",
  ],
  linear: ["Linear"],
  notion: ["Notion"],
  github: ["GitHub"],
  atlassian: ["Atlassian", "Atlassian Rovo", "Jira", "Confluence"],
  intercom: ["Intercom"],
  "wispr-flow": ["Wispr Flow"],
  slack: ["Slack"],
  fathom: ["Fathom"],
  figma: [],
} as const satisfies Record<IntegrationCatalogId, ReadonlyArray<string>>;

const covered = (entry: IntegrationCatalogEntry) => entry.kind !== "unavailable";

/** Service names, e.g. "Gmail", whose provider connector duplicates a catalog entry. */
export const DUPLICATE_SERVICE_NAMES: ReadonlyArray<string> = INTEGRATION_CATALOG.filter(
  covered,
).flatMap((entry) => PROVIDER_SERVICE_NAMES[entry.id]);

/** Origins of the catalog's remote MCP endpoints, e.g. `https://mcp.linear.app`. */
export const DUPLICATE_SERVER_ORIGINS: ReadonlyArray<string> = Array.from(
  new Set(
    INTEGRATION_CATALOG.filter(covered).flatMap((entry) =>
      entry.kind === "remote" ? entry.regions.map((region) => new URL(region.url).origin) : [],
    ),
  ),
);

const normalizedName = (name: string) => name.trim().toLowerCase().replaceAll(/\s+/g, " ");
const duplicateNames = new Set(DUPLICATE_SERVICE_NAMES.map(normalizedName));

/** Whether a provider connector named `name` (e.g. a ChatGPT app) duplicates a catalog service. */
export const isDuplicateServiceName = (name: string): boolean =>
  duplicateNames.has(normalizedName(name));

/** Whether an MCP server at `url` (a URL or bare origin) is a catalog service's endpoint. */
export const isDuplicateServerUrl = (url: string | null | undefined): boolean => {
  const origin = url == null ? null : URL.parse(url)?.origin;
  return origin != null && DUPLICATE_SERVER_ORIGINS.includes(origin);
};

export type ClaudeDeniedMcpServer =
  | { readonly serverName: string }
  | { readonly serverUrl: string };

/**
 * Claude Code's `deniedMcpServers` entries for the duplicates. The CLI merges
 * this setting from every source, including the per-session flag settings,
 * and applies it to claude.ai connectors (named `claude.ai <Service>`), plugin
 * servers and the user's own config alike, without touching any config file.
 */
export const CLAUDE_DENIED_DUPLICATE_MCP_SERVERS: ReadonlyArray<ClaudeDeniedMcpServer> = [
  ...DUPLICATE_SERVICE_NAMES.map((name) => ({ serverName: `claude.ai ${name}` })),
  ...DUPLICATE_SERVER_ORIGINS.map((origin) => ({ serverUrl: `${origin}/*` })),
];

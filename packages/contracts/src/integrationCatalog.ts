import * as Schema from "effect/Schema";
import type { Integration } from "./integration.ts";

/**
 * The default integrations catalog: services Cogenly knows how to connect, so
 * Settings and agents ask only for what each one needs. One list for the
 * server (connectFromCatalog), Settings (the catalog grid) and the per-turn
 * "also available to connect" line.
 */

export const IntegrationCatalogId = Schema.Literals([
  "google-workspace",
  "linear",
  "notion",
  "github",
  "atlassian",
  "intercom",
  "wispr-flow",
  "slack",
  "fathom",
  "figma",
]);
export type IntegrationCatalogId = typeof IntegrationCatalogId.Type;

/**
 * `oauth`: sign in, with the server registering Cogenly itself. `oauth_app`:
 * sign in through an app the user created with the service (client id and a
 * vault reference to its secret). `api_key`: a key or token sent as a bearer
 * token, from a vault reference.
 */
export const IntegrationCatalogAuthKind = Schema.Literals(["oauth", "oauth_app", "api_key"]);
export type IntegrationCatalogAuthKind = typeof IntegrationCatalogAuthKind.Type;

export interface IntegrationCatalogAuthMode {
  readonly kind: IntegrationCatalogAuthKind;
  /** What Settings calls it, e.g. "Personal access token". */
  readonly label: string;
}

export interface IntegrationCatalogRegion {
  readonly id: string;
  readonly label: string;
  readonly url: string;
}

interface IntegrationCatalogBase {
  readonly id: IntegrationCatalogId;
  readonly name: string;
  /** One line on what agents can do with it. */
  readonly description: string;
  /** Which icon clients draw. */
  readonly icon: IntegrationCatalogId;
  /** Anchor in docs/user/integrations.md. */
  readonly docsAnchor: string;
}

export type IntegrationCatalogEntry =
  | (IntegrationCatalogBase & {
      readonly kind: "remote";
      /** The first is the only one when the service has no regions. */
      readonly regions: readonly [IntegrationCatalogRegion, ...IntegrationCatalogRegion[]];
      /** The first mode that needs no inputs is the default. */
      readonly auth: readonly [IntegrationCatalogAuthMode, ...IntegrationCatalogAuthMode[]];
      /** Space-separated OAuth scopes to ask for, when the server's advertised set is wrong. */
      readonly oauthScope?: string;
      /** Where a client secret travels, so its vault item can allow that host. */
      readonly tokenHost?: string;
    })
  | (IntegrationCatalogBase & {
      readonly kind: "local-preset";
      readonly preset: "google-workspace";
    })
  | (IntegrationCatalogBase & {
      readonly kind: "unavailable";
      readonly url: string;
      /** Why it cannot be connected yet. */
      readonly reason: string;
    });

/** User scopes the Slack MCP server's tools use (docs.slack.dev/ai/slack-mcp-server). */
export const SLACK_MCP_USER_SCOPES = [
  "search:read.public",
  "search:read.private",
  "search:read.mpim",
  "search:read.im",
  "search:read.files",
  "search:read.users",
  "chat:write",
  "channels:history",
  "groups:history",
  "mpim:history",
  "im:history",
  "channels:read",
  "groups:read",
  "mpim:read",
  "im:read",
  "channels:write",
  "groups:write",
  "mpim:write",
  "im:write",
  "canvases:read",
  "canvases:write",
  "lists:read",
  "lists:write",
  "files:read",
  "files:write",
  "reactions:read",
  "reactions:write",
  "emoji:read",
  "users:read",
  "users:read.email",
] as const;

const SIGN_IN = { kind: "oauth", label: "Sign in" } as const;

export const INTEGRATION_CATALOG: ReadonlyArray<IntegrationCatalogEntry> = [
  {
    id: "google-workspace",
    name: "Google Workspace",
    description: "Read and send Gmail, manage Calendar, and work in Drive, Docs and Sheets.",
    icon: "google-workspace",
    docsAnchor: "connect-google",
    kind: "local-preset",
    preset: "google-workspace",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Find, create and update issues, projects and comments.",
    icon: "linear",
    docsAnchor: "default-integrations",
    kind: "remote",
    regions: [{ id: "default", label: "Linear", url: "https://mcp.linear.app/mcp" }],
    auth: [SIGN_IN, { kind: "api_key", label: "API key" }],
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search, read and edit pages and databases.",
    icon: "notion",
    docsAnchor: "default-integrations",
    kind: "remote",
    regions: [{ id: "default", label: "Notion", url: "https://mcp.notion.com/mcp" }],
    auth: [SIGN_IN],
  },
  {
    id: "github",
    name: "GitHub",
    description: "Work with repositories, issues, pull requests and Actions.",
    icon: "github",
    docsAnchor: "default-integrations",
    kind: "remote",
    regions: [{ id: "default", label: "GitHub", url: "https://api.githubcopilot.com/mcp/" }],
    auth: [
      { kind: "api_key", label: "Personal access token" },
      { kind: "oauth_app", label: "Your OAuth app" },
    ],
    tokenHost: "github.com",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    description: "Search and update Jira issues and Confluence pages.",
    icon: "atlassian",
    docsAnchor: "default-integrations",
    kind: "remote",
    regions: [{ id: "default", label: "Atlassian", url: "https://mcp.atlassian.com/v1/mcp" }],
    auth: [SIGN_IN],
  },
  {
    id: "intercom",
    name: "Intercom",
    description: "Look up conversations, contacts and companies. Mostly read-only.",
    icon: "intercom",
    docsAnchor: "default-integrations",
    kind: "remote",
    regions: [
      { id: "us", label: "United States", url: "https://mcp.intercom.com/mcp" },
      { id: "eu", label: "Europe", url: "https://mcp.eu.intercom.com/mcp" },
    ],
    auth: [SIGN_IN, { kind: "api_key", label: "Access token" }],
  },
  {
    id: "wispr-flow",
    name: "Wispr Flow",
    description: "Read meeting notes, transcripts and scratchpad notes from Notetaker.",
    icon: "wispr-flow",
    docsAnchor: "default-integrations",
    kind: "remote",
    regions: [{ id: "default", label: "Wispr Flow", url: "https://api.wisprflow.ai/connect/mcp" }],
    auth: [SIGN_IN],
  },
  {
    id: "slack",
    name: "Slack",
    description: "Search and read channels and threads, and send messages as you.",
    icon: "slack",
    docsAnchor: "connect-slack",
    kind: "remote",
    regions: [{ id: "default", label: "Slack", url: "https://mcp.slack.com/mcp" }],
    auth: [{ kind: "oauth_app", label: "Your Slack app" }],
    oauthScope: SLACK_MCP_USER_SCOPES.join(" "),
    tokenHost: "slack.com",
  },
  {
    id: "fathom",
    name: "Fathom",
    description: "Read meeting recordings, summaries, transcripts and action items.",
    icon: "fathom",
    docsAnchor: "default-integrations",
    kind: "remote",
    regions: [{ id: "default", label: "Fathom", url: "https://api.fathom.ai/mcp" }],
    auth: [SIGN_IN],
  },
  {
    id: "figma",
    name: "Figma",
    description: "Read designs, components and variables.",
    icon: "figma",
    docsAnchor: "default-integrations",
    kind: "unavailable",
    url: "https://mcp.figma.com/mcp",
    reason: "Figma only admits clients it has approved, so Cogenly can't connect yet.",
  },
];

export function integrationCatalogEntry(id: string): IntegrationCatalogEntry | undefined {
  return INTEGRATION_CATALOG.find((entry) => entry.id === id);
}

const comparableUrl = (url: string): string | undefined => {
  const parsed = URL.parse(url);
  return parsed === null ? undefined : `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
};

/**
 * The catalog entry an integration was connected from: the Google preset for
 * a managed Google account, otherwise the entry whose endpoint it points at,
 * so integrations added by hand group under their service too.
 */
export function integrationCatalogEntryFor(
  integration: Pick<Integration, "transport" | "url" | "local">,
): IntegrationCatalogEntry | undefined {
  if (integration.transport === "local")
    return INTEGRATION_CATALOG.find(
      (entry) => entry.kind === "local-preset" && entry.preset === integration.local?.preset,
    );
  const url = comparableUrl(integration.url);
  if (url === undefined) return undefined;
  return INTEGRATION_CATALOG.find(
    (entry) =>
      entry.kind === "remote" && entry.regions.some((region) => comparableUrl(region.url) === url),
  );
}

/** What a catalog entry asks for with one auth mode, in the order Settings shows it. */
export function integrationCatalogInputs(
  entry: IntegrationCatalogEntry,
  auth: IntegrationCatalogAuthKind | undefined,
): ReadonlyArray<"region" | "apiKey" | "clientId" | "clientSecret"> {
  if (entry.kind !== "remote") return [];
  return [
    ...(entry.regions.length > 1 ? (["region"] as const) : []),
    ...(auth === "api_key" ? (["apiKey"] as const) : []),
    ...(auth === "oauth_app" ? (["clientId", "clientSecret"] as const) : []),
  ];
}

/**
 * A Slack app manifest for the Slack MCP server. `redirectUrl` is this
 * Cogenly's `/oauth/integrations/callback`. Slack needs a bot user for its
 * user-token consent page, so the manifest asks for one minimal bot scope.
 */
export function slackAppManifest(redirectUrl: string): string {
  return JSON.stringify(
    {
      display_information: {
        name: "Cogenly",
        description: "Lets your Cogenly agents use Slack as you.",
      },
      features: { bot_user: { display_name: "Cogenly", always_online: false } },
      oauth_config: {
        redirect_urls: [redirectUrl],
        scopes: { user: [...SLACK_MCP_USER_SCOPES], bot: ["users:read"] },
      },
      settings: { org_deploy_enabled: false, socket_mode_enabled: false },
    },
    null,
    2,
  );
}

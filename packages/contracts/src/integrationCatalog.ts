import * as Schema from "effect/Schema";
import type { Integration } from "./integration.ts";

/**
 * The default integrations catalog: services Cogenly knows how to connect, so
 * Settings and agents ask only for what each one needs. One list for the
 * server (connectFromCatalog), Settings (the catalog grid) and the per-turn
 * "also available to connect" line. Anything else is a custom MCP server.
 */

export const IntegrationCatalogId = Schema.Literals([
  "google-workspace",
  "slack",
  "github",
  "linear",
  "notion",
  "wispr-flow",
  "fathom",
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
      /** The service's MCP endpoint. */
      readonly url: string;
      /** The first mode is the default. */
      readonly auth: readonly [IntegrationCatalogAuthMode, ...IntegrationCatalogAuthMode[]];
      /** Space-separated OAuth scopes to ask for, when the server's advertised set is wrong. */
      readonly oauthScope?: string;
      /** Where a client secret travels, so its vault item can allow that host. */
      readonly tokenHost?: string;
    })
  | (IntegrationCatalogBase & {
      readonly kind: "local-preset";
      readonly preset: "google-workspace";
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

/**
 * Endpoints as probed on 2026-10-24. Linear, Notion, Wispr Flow and Fathom
 * register clients automatically, so they sign in with one click. GitHub
 * (authorization server github.com/login/oauth) and Slack do not, so they
 * take a token or the owner's own app.
 */
export const INTEGRATION_CATALOG: ReadonlyArray<IntegrationCatalogEntry> = [
  {
    id: "google-workspace",
    name: "Google Workspace",
    description: "Read and send Gmail, manage Calendar, and work in Drive and Docs.",
    icon: "google-workspace",
    docsAnchor: "connect-google",
    kind: "local-preset",
    preset: "google-workspace",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Search and read channels and threads, and send messages as you.",
    icon: "slack",
    docsAnchor: "connect-slack",
    kind: "remote",
    url: "https://mcp.slack.com/mcp",
    auth: [{ kind: "oauth_app", label: "Your Slack app" }],
    oauthScope: SLACK_MCP_USER_SCOPES.join(" "),
    tokenHost: "slack.com",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Work with repositories, issues, pull requests and Actions.",
    icon: "github",
    docsAnchor: "connect-github",
    kind: "remote",
    url: "https://api.githubcopilot.com/mcp/",
    auth: [
      { kind: "api_key", label: "Personal access token" },
      { kind: "oauth_app", label: "Your OAuth app" },
    ],
    tokenHost: "github.com",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Find, create and update issues, projects and comments.",
    icon: "linear",
    docsAnchor: "default-integrations",
    kind: "remote",
    url: "https://mcp.linear.app/mcp",
    auth: [SIGN_IN, { kind: "api_key", label: "API key" }],
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search, read and edit pages and databases.",
    icon: "notion",
    docsAnchor: "default-integrations",
    kind: "remote",
    url: "https://mcp.notion.com/mcp",
    auth: [SIGN_IN],
  },
  {
    id: "wispr-flow",
    name: "Wispr Flow",
    description: "Read meeting notes, transcripts and scratchpad notes from Notetaker.",
    icon: "wispr-flow",
    docsAnchor: "default-integrations",
    kind: "remote",
    url: "https://api.wisprflow.ai/connect/mcp",
    auth: [SIGN_IN],
  },
  {
    id: "fathom",
    name: "Fathom",
    description: "Read meeting recordings, summaries, transcripts and action items.",
    icon: "fathom",
    docsAnchor: "default-integrations",
    kind: "remote",
    url: "https://api.fathom.ai/mcp",
    auth: [SIGN_IN],
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
 * so integrations added by hand group under their service too. Anything else,
 * including accounts of services the catalog no longer lists, is custom.
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
    (entry) => entry.kind === "remote" && comparableUrl(entry.url) === url,
  );
}

/** What a catalog entry asks for with one auth mode, in the order Settings shows it. */
export function integrationCatalogInputs(
  entry: IntegrationCatalogEntry,
  auth: IntegrationCatalogAuthKind | undefined,
): ReadonlyArray<"apiKey" | "clientId" | "clientSecret"> {
  if (entry.kind !== "remote") return [];
  return [
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

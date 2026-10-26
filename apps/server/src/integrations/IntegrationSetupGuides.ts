import {
  integrationCatalogEntry,
  integrationCatalogEntryFor,
  type Integration,
  type IntegrationCatalogId,
  type IntegrationSetupGuideResult,
} from "@cogenly/contracts";

// Setup knowledge belongs to agents. Keep uncertain provider requirements explicit.
const GUIDES: Record<IntegrationCatalogId | "custom", string> = {
  "google-workspace": `Use Cogenly's managed workspace-mcp 2.1.2 stdio preset (not a Google-hosted MCP endpoint). It covers Gmail, Calendar, Drive, Docs and Sheets. Authentication is a user-supplied Google Web application OAuth client plus per-account consent.
Check vault metadata for google-oauth-client first; if it exists, skip to integration_add. Otherwise call integration_add with catalogId google-workspace and an accountLabel to get the exact redirect URI and scopes, then do the Google Cloud console work yourself in the collaborative browser, signed in as the account that should own the app:
1. Open https://console.cloud.google.com/cloud-resource-manager and look for a project named Cogenly. Reuse it if it exists; otherwise create one at https://console.cloud.google.com/projectcreate named Cogenly, with a project ID like cogenly-<4 random characters>. Select that project for every following page.
2. Enable the Gmail, Calendar, Drive, Docs and Sheets APIs: https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com,docs.googleapis.com,sheets.googleapis.com
3. Branding (https://console.cloud.google.com/auth/branding): app name Cogenly, the account's email as support and developer contact. Audience: External for personal Gmail, Internal only when every account belongs to one Workspace organization. On Audience, add the account the user will connect as a test user before testing consent. Then choose Publish app at https://console.cloud.google.com/auth/audience and verify it reads In production; in Testing, Google expires refresh tokens after seven days. If Publish does nothing, re-open Branding and Verification Center and inspect validation errors, save again, then reload Audience and check the actual publishing status. A Branding incomplete state can remain even when fields look filled. Check support/developer email, authorized domain, real home page, privacy policy and Terms of Service links. A logo can require brand verification; remove an optional logo if it is blocking personal setup. Some scopes require domain ownership verification through Search Console. Never invent domains or legal links or claim publication succeeded because a click completed; if blocked, record the blocker in setupNotes and keep Testing with its seven-day token expiry explicit. An unverified-app warning is expected for the user's own app; do not promise it suits other users.
4. Data access (https://console.cloud.google.com/auth/scopes): add the scopes integration_add returned.
5. Clients (https://console.cloud.google.com/auth/clients): reuse a Web application client named Cogenly if one exists, adding the redirect URI if it is missing; otherwise create one named Cogenly of type Web application with that exact Authorized redirect URI (it ends in /oauth/integrations/google/callback on the Cogenly origin the user's browser reaches: local, Tailscale HTTPS or VPS HTTPS).
6. Before closing the OAuth client created dialog, capture the client while Google still shows it. Use vault_capture {name: "google-oauth-client", kind: "api_key", locator: <client-secret locator>, clientIdLocator: <client-id locator>, domains: ["accounts.google.com"]}; this stores client_id/client_secret JSON directly in the vault. If the only secret is in a copy button aria-label, use attribute: "aria-label" with the secret button locator. Never read that aria-label with evaluate, extract or snapshot. A client JSON download is another way to retain the once-only secret: keep it private, and import directly into the vault without printing or reading its contents into model context. Do not close the dialog until vault_list confirms the item. Never repeat a secret in chat or read a native credential file.
Then retry integration_add with catalogId google-workspace, accountLabel, callbackOrigin and setupNotes (project ID, client ID, redirect URI, owning account, date). Install uv on the server with integration_install_runtime if needed. The inline Sign in card opens Google's consent page in the user's browser; they choose the account and consent. Recheck integrations_list and integration_test, then integration_tools; verify Gmail with a read-only tool and the signed-in user_google_email. Workspace admin approval may still need the user's admin.
Sources: https://github.com/taylorwilsdon/google_workspace_mcp, https://developers.google.com/identity/protocols/oauth2/web-server and https://developers.google.com/identity/verification/authentication-verification`,
  "wispr-flow": `Remote Streamable HTTP: https://api.wisprflow.ai/connect/mcp. OAuth with the user's Wispr account; no API key. Call integration_add with catalogId wispr-flow, optional accountLabel, and a reachable callbackOrigin. Cogenly discovers OAuth metadata and registers a client where supported. The inline Sign in card opens the consent page in the user's browser; after it connects, use integrations_list, integration_test and integration_tools, then a read-only meeting search. Do not claim success from creation alone.
The user's account needs Notetaker with Cloud Sync enabled. Enterprise admins must enable the MCP connector (and Scratchpad access for notes); HIPAA-covered accounts are unsupported. If access is denied, ask the user to check these settings; do not invent a key or a console app. Exact scopes and registration availability are discovered live, not hardcoded. Access is read-only and does not expose local dictation history.
Sources: https://github.com/Wispr-AI/wispr-flow-plugin and https://docs.wisprflow.ai/articles/4759919286-how-to-connect-wispr-flow-to-claude-chatgpt-and-other-ai-tools-mcp`,
  slack: `Remote Streamable HTTP: https://mcp.slack.com/mcp. Confidential OAuth requires the user's own Slack app; automatic client registration is unavailable. Call integration_add catalogId slack first for the app manifest and exact HTTPS /oauth/integrations/callback URI. In the collaborative browser at https://api.slack.com/apps, reuse an app named Cogenly in the target workspace if one exists; otherwise create one From a manifest named Cogenly with that manifest. Enable Model Context Protocol under Agents & AI Apps. Slack permits internal or Marketplace apps, not unlisted apps. Read the Client ID and Client Secret from Basic Information, store the secret with vault_save as an api_key allowing slack.com, and pass clientId plus clientSecret {{credential:<item>.value}} and setupNotes (app ID, workspace, redirect URI, date) to integration_add catalogId slack. The preset requests search, history, channel, file, user, canvas, list, reaction and messaging scopes; narrow access to the user's task where possible. The user approves workspace consent. Verify with integration_test and a read-only tool. Workspace administrators may need to authorize installation.
Source: https://docs.slack.dev/ai/slack-mcp-server`,
  github: `Remote Streamable HTTP: https://api.githubcopilot.com/mcp/. Prefer a fine-grained personal access token. Create it yourself in the collaborative browser at https://github.com/settings/personal-access-tokens/new, named Cogenly (reuse or regenerate an existing Cogenly token rather than adding another), with only the repositories and permissions the user's task needs. Save it with vault_save as an api_key allowing api.githubcopilot.com; call integration_add catalogId github with apiKey {{credential:<item>.value}} and setupNotes (token name, repositories, expiry, date). Never put tokens in literal headers. OAuth is an alternative requiring a registered app named Cogenly at https://github.com/settings/applications/new; Cogenly does not assume dynamic registration. Register the returned /oauth/integrations/callback URI and save the secret with vault_save, allowing github.com. Exact organization approvals and permissions depend on the account. Verify with integration_test, integration_tools and a read-only repository query.
Source: https://github.com/github/github-mcp-server`,
  linear: `Remote Streamable HTTP: https://mcp.linear.app/mcp. OAuth 2.1 supports dynamic client registration. Call integration_add catalogId linear ; the inline Sign in card handles consent. Discover scopes live. For read-only access use a custom integration at https://mcp.linear.app/mcp/readonly or request scope read. An API key also works: create one named Cogenly at https://linear.app/settings/account/security in the collaborative browser, save it with vault_save as an api_key allowing mcp.linear.app and pass apiKey {{credential:<item>.value}}. Verify with integration_test and a read-only issue query. Create separate integrations for separate workspaces.
Source: https://linear.app/docs/mcp`,
  notion: `Remote Streamable HTTP: https://mcp.notion.com/mcp. OAuth consent connects the user's workspace. Call integration_add catalogId notion, the inline Sign in card handles consent, then integration_test and a read-only page search. Discover scopes and registration support from server metadata rather than inventing them. Enterprise workspace owners may restrict which MCP clients can connect. Do not substitute an internal integration token for hosted MCP OAuth without verifying support.
Source: https://developers.notion.com/docs/mcp`,
  fathom: `Remote Streamable HTTP: https://api.fathom.ai/mcp. OAuth consent grants meeting access. Call integration_add catalogId fathom and let the inline Sign in card handle consent, then integration_test, integration_tools and a read-only meeting query. Discover registration and scopes live. The endpoint is verified in vendor documentation; plan eligibility, exact scopes and account restrictions have not been verified here. Do not promise an API key works with this MCP endpoint merely because Fathom's REST API accepts one.
Source: https://developers.fathom.ai/mcp-docs`,
  custom: `For any MCP server use its vendor's documented URL (Streamable HTTP) or executable/arguments (stdio). Verify transport, auth, scopes and package identity from primary documentation; do not guess endpoints or shell out to a provider's native MCP config. For HTTP call integration_add with name, displayName, transport http, url, headers {}, scope and hint. Set auth {type: "oauth"} for discovery, PKCE and dynamic registration where supported; when a client is required obtain its exact redirect URI, then request client credentials privately into the vault. Create any app, client or token in the vendor's console yourself, named Cogenly. For static tokens use only {{credential:<item>.<field>}} header templates. For stdio use transport stdio and a command definition with command, args and env templates; secrets belong in env vault references, never argv. Cogenly runs the process on its server, so install dependencies there. Select the minimum project scope. Let the inline Sign in card handle OAuth consent, then use integration_test and a harmless read-only tool to verify. A successful tool list alone does not prove required data scopes. If unsupported transport or vendor requirements block setup, report the precise missing piece.`,
};

const COMMON = `You do the whole setup yourself, end to end, in the Cogenly collaborative browser (preview_* tools): console sign-in, creating projects, apps, clients and keys, enabling APIs, filling consent screens, copying ids. Never hand the user a list of console steps, never send them to a setup wizard, and never ask them to show the browser panel or confirm before you start; visible=false does not block automation, so just act. Stop only for what the account owner alone can do: a password with no vault item, a 2FA or passkey prompt, an admin approval, and the final OAuth consent. Before asking the user for anything, check vault_list for a saved login on the console's site (e.g. accounts.google.com, slack.com) and sign in with vault_fill; a site can have several logins, so pick the account that should own the integration by itemId, and ask the user only if you cannot tell. When none exists, ask for it with request_login when that tool is available (otherwise request_secret with saveToVault, or let the user type it into the tab), then continue. Once connected, record which login it signs in with using vault_link_integration.
Name everything you create on the user's behalf Cogenly: cloud project display name Cogenly (an ID like cogenly-xxxx where it must be unique), OAuth app or consent screen Cogenly, OAuth client Cogenly, Slack app Cogenly, token Cogenly. Look for an existing Cogenly project, app or client first and reuse it rather than creating a duplicate.
Record what you set up in setupNotes on integration_add or integration_update: what was created where (project ID, app or client ID, redirect URIs), which account owns it, and the date. Never put secrets in notes. Before repairing an integration, read its setupNotes in integrations_list, and update them after you change the setup.
Owner approval, OAuth sign-in and field corrections appear as an inline integration card in this thread: the Sign in button opens the user's browser. Inline card answers, including a finished sign-in, automatically notify the thread, steering active work or starting a new turn. Never send the user a Settings URL or paste a sign-in link; say you are waiting on the card, and never ask the user to allow it or type continue. Settings only manages connected accounts.
Inspect existing integrations first to avoid duplicates. Tokens stay in the vault; collect secrets only the user knows through request_secret with saveToVault, capture secrets shown on pages directly with vault_capture without reading them into context, and save other values you obtained with vault_save. Pass callbackOrigin explicitly for first-time OAuth from a remote/VPS or Tailscale connection; localhost on the server is not reachable from another device. Call integration_update with just the name to resume sign-in. Persistent agents use the normal owner-approval path. Never perform a write just to verify connectivity.`;

export function integrationSetupGuide(
  service: string,
  existing: ReadonlyArray<Integration> = [],
): IntegrationSetupGuideResult {
  const normalized = service.trim().toLowerCase();
  const id = ["gmail", "google", "google workspace"].includes(normalized)
    ? "google-workspace"
    : ["wispr", "wispr flow"].includes(normalized)
      ? "wispr-flow"
      : normalized;
  const key =
    id === "custom" || integrationCatalogEntry(id) !== undefined
      ? (id as keyof typeof GUIDES)
      : "custom";
  const instructions = `${COMMON}\n\n${GUIDES[key]}`;
  const notes = existing.flatMap((integration) =>
    integration.setupNotes !== undefined && matchesService(integration, key, service)
      ? [
          {
            name: integration.name,
            displayName: integration.displayName,
            ...(integration.accountLabel ? { accountLabel: integration.accountLabel } : {}),
            setupNotes: integration.setupNotes,
            ...(integration.setupNotesUpdatedAt
              ? { setupNotesUpdatedAt: integration.setupNotesUpdatedAt }
              : {}),
          },
        ]
      : [],
  );
  if (notes.length === 0) return { service: key, instructions };
  // Notes first, so a re-auth or a move to another machine reuses what was already made.
  const recorded = notes
    .map(
      (note) =>
        `- ${note.displayName}${note.accountLabel ? ` (${note.accountLabel})` : ""}, integration ${note.name}: ${note.setupNotes}`,
    )
    .join("\n");
  return {
    service: key,
    existingSetupNotes: notes,
    instructions: `Existing setup notes. An earlier agent already set this up; reuse what it created (project, app, client, redirect URIs) instead of starting over, and update the notes with integration_update after you change anything:\n${recorded}\n\n${instructions}`,
  };
}

/** Whether an existing integration is an account of the service the guide is for. */
function matchesService(integration: Integration, key: string, service: string) {
  if (key !== "custom") return integrationCatalogEntryFor(integration)?.id === key;
  const wanted = service.trim().toLowerCase();
  return (
    integration.name.toLowerCase() === wanted ||
    integration.displayName.toLowerCase() === wanted ||
    integration.url.toLowerCase() === wanted
  );
}

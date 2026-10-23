import {
  IntegrationName,
  type GoogleWorkspaceAddInput,
  type IntegrationCreateInput,
} from "@t3tools/contracts";
import { type LocalMcpSpec } from "./LocalMcpRunner.ts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { managedPackageCommand } from "./ManagedPackage.ts";

// Verified against the PyPI 2.1.2 sdist: main.py, auth/oauth_config.py and auth/credential_store.py.
export const GOOGLE_WORKSPACE_VERSION = "2.1.2";
export const GOOGLE_CALLBACK_PATH = "/oauth/integrations/google/callback";
export const GOOGLE_SIGN_IN_PATH = "/oauth/integrations/google/start";
export const GOOGLE_CLIENT_HELP =
  'Store your downloaded Google Web application OAuth client JSON as the value of vault item google-oauth-client, allowing accounts.google.com. Use request_secret with saveToVault: {name: "google-oauth-client", type: "api_key", domains: ["accounts.google.com"]}; never paste credentials into chat. Alternatively, save a login with client ID as username and secret as password. See docs/user/integrations.md#connect-google.';

const GoogleClient = Schema.Struct({
  client_id: Schema.String.check(Schema.isMinLength(1)),
  client_secret: Schema.String.check(Schema.isMinLength(1)),
});
const decodeClient = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([GoogleClient, Schema.Struct({ web: GoogleClient })])),
);

/** Google's downloaded Web application JSON fits in a single private request_secret card. */
export const googleClientFromJson = (text: string) =>
  Option.map(decodeClient(text), (decoded) => {
    const client = "web" in decoded ? decoded.web : decoded;
    return { clientId: client.client_id, clientSecret: client.client_secret };
  });

const command = managedPackageCommand({
  ecosystem: "python",
  name: "workspace-mcp",
  version: GOOGLE_WORKSPACE_VERSION,
});

export const googleWorkspaceInput = (
  input: GoogleWorkspaceAddInput,
  defaultOrigin: string,
): IntegrationCreateInput => ({
  name:
    input.name ??
    IntegrationName.make(
      `google-${
        input.accountLabel
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 50) || "account"
      }`,
    ),
  displayName: `Google · ${input.accountLabel}`,
  transport: "local",
  url: "https://accounts.google.com",
  headers: {},
  local: {
    preset: "google-workspace",
    version: GOOGLE_WORKSPACE_VERSION,
    accountLabel: input.accountLabel,
    callbackOrigin: input.callbackOrigin ?? defaultOrigin,
  },
  scope: input.scope ?? { type: "all" },
  hint: "Gmail, Calendar, Drive, Docs and Sheets",
});

/** A fixed preset, not an arbitrary command supplied through MCP or settings. */
export const googleWorkspaceSpec = (input: {
  readonly id: string;
  readonly directory: string;
  readonly credentialsDirectory: string;
  readonly port: number;
  readonly callbackOrigin: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly environment: Readonly<Record<string, string>>;
}): LocalMcpSpec => ({
  id: input.id,
  runtime: command.runtime,
  args: [
    ...command.args,
    "--transport",
    "streamable-http",
    "--single-user",
    "--tool-tier",
    "complete",
    "--tools",
    "gmail",
    "calendar",
    "drive",
    "docs",
    "sheets",
  ],
  version: GOOGLE_WORKSPACE_VERSION,
  directory: input.directory,
  transport: "http",
  port: input.port,
  env: {
    ...input.environment,
    GOOGLE_OAUTH_CLIENT_ID: input.clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: input.clientSecret,
    GOOGLE_OAUTH_REDIRECT_URI: `${input.callbackOrigin}${GOOGLE_CALLBACK_PATH}`,
    WORKSPACE_MCP_HOST: "127.0.0.1",
    WORKSPACE_MCP_PORT: String(input.port),
    WORKSPACE_MCP_PORT_FALLBACK_COUNT: "0",
    WORKSPACE_MCP_CREDENTIALS_DIR: input.credentialsDirectory,
    WORKSPACE_MCP_LOG_DIR: `${input.directory}/logs`,
    MCP_SINGLE_USER_MODE: "1",
    MCP_ENABLE_OAUTH21: "false",
    OAUTHLIB_INSECURE_TRANSPORT: "1",
    WORKSPACE_MCP_DISABLE_LOCAL_FILES: "true",
  },
  secrets: [input.clientId, input.clientSecret],
});

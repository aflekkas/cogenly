import { integrationSetupGuide } from "./IntegrationSetupGuides.ts";
import {
  integrationCatalogEntry,
  integrationCatalogEntryFor,
  slackAppManifest,
  type Integration,
  type IntegrationAgentResult,
  type IntegrationCatalogAuthKind,
  type IntegrationCatalogEntry,
  type IntegrationConnectionStatus,
  type IntegrationConnectResult,
  type IntegrationError,
  type IntegrationSetupAction,
  type IntegrationSetupStep,
  type IntegrationSummary,
  type IntegrationSyncedFrom,
} from "@t3tools/contracts";

/**
 * The next action for an integration that cannot be used yet, from the
 * catalog entry, the account's status and the last error. One mapping for
 * Settings (the inline step on a row) and agents (the same step in words,
 * through `agentNextStep`), so the two never disagree.
 */

export const GOOGLE_CLIENT_ITEM = "google-oauth-client";
const GOOGLE_HOST = "accounts.google.com";

/**
 * What the managed Google server asks Google for: workspace-mcp's
 * `get_scopes_for_tools` (auth/scopes.py) for gmail, calendar, drive, docs
 * and sheets, which unions the base scopes with each tool's full set.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
] as const;

const GOOGLE_APIS = [
  "gmail.googleapis.com",
  "calendar-json.googleapis.com",
  "drive.googleapis.com",
  "docs.googleapis.com",
  "sheets.googleapis.com",
];

/** Where each service hands out keys, for its `api_key` mode. */
const API_KEY_HELP: Partial<
  Record<IntegrationCatalogEntry["id"], { readonly url: string; readonly how: string }>
> = {
  github: {
    url: "https://github.com/settings/personal-access-tokens/new",
    how: "Create a fine-grained personal access token with access to the repositories agents should work in, then paste it here.",
  },
  linear: {
    url: "https://linear.app/settings/account/security",
    how: "Create a personal API key under Security & access in Linear's settings, then paste it here.",
  },
};

type Target = Pick<Integration, "id" | "displayName" | "accountLabel" | "auth" | "headers">;

export interface SetupInput {
  readonly entry: IntegrationCatalogEntry | undefined;
  /** The account, once one exists. */
  readonly integration?: Target | undefined;
  readonly status?: IntegrationConnectionStatus | undefined;
  /** Why the last attempt failed. */
  readonly reason?: IntegrationError["reason"] | undefined;
  /** The last failure in plain words, already bounded and credential-free. */
  readonly message?: string | undefined;
  /** The redirect URI the service's app must accept, when this server knows its address. */
  readonly redirectUri?: string | undefined;
  /** Whether Cogenly can install a missing runtime, and the command a person runs instead. */
  readonly runtime?: { readonly canInstall: boolean; readonly command: string } | undefined;
  readonly syncedFrom?: IntegrationSyncedFrom | undefined;
  /** The auth mode being connected, before an account exists. */
  readonly mode?: IntegrationCatalogAuthKind | undefined;
}

const titleOf = (input: SetupInput) => {
  const service = input.entry?.name ?? input.integration?.displayName ?? "This integration";
  const label = input.integration?.accountLabel?.trim();
  return { service, account: label ? `${service} (${label})` : service };
};

const baseOf = (input: SetupInput) => ({
  ...(input.integration === undefined ? {} : { integrationId: input.integration.id }),
  ...(input.entry === undefined ? {} : { catalogId: input.entry.id }),
});

const signIn = (input: SetupInput): IntegrationSetupAction => {
  const { service, account } = titleOf(input);
  if (input.syncedFrom !== undefined)
    return {
      type: "sign_in",
      ...baseOf(input),
      title: "Sign in on this machine",
      message: `${account} was connected on ${input.syncedFrom.machineLabel}. Sign in here too so agents on this machine can use it.`,
    };
  return {
    type: "sign_in",
    ...baseOf(input),
    title: `Sign in to ${service}`,
    message:
      input.message !== undefined && input.reason === "sign_in_required"
        ? input.message
        : `${account} needs you to sign in before agents can use it.`,
  };
};

const googleSteps = (redirectUri: string | undefined): Array<IntegrationSetupStep> => [
  {
    text: "Create a Google Cloud project, or pick one you already use for this.",
    url: "https://console.cloud.google.com/projectcreate",
  },
  {
    text: "Turn on the Gmail, Calendar, Drive, Docs and Sheets APIs for that project.",
    url: `https://console.cloud.google.com/flows/enableapi?apiid=${GOOGLE_APIS.join(",")}`,
  },
  {
    text: "Set up the consent screen: give the app a name and your email. Choose External for personal Gmail, or Internal if every account belongs to your Workspace organization.",
    url: "https://console.cloud.google.com/auth/branding",
  },
  {
    text: "Under Audience, choose Publish app so the status reads In production. In Testing, Google signs you out every seven days. Google will warn that the app is unverified; that is expected for your own app.",
    url: "https://console.cloud.google.com/auth/audience",
  },
  {
    text: "Under Data access, add these scopes.",
    url: "https://console.cloud.google.com/auth/scopes",
    copy: { label: "Scopes", value: GOOGLE_SCOPES.join(" ") },
  },
  {
    text: "Create an OAuth client of type Web application, and add this exact Authorized redirect URI.",
    url: "https://console.cloud.google.com/auth/clients/create",
    ...(redirectUri === undefined
      ? {}
      : { copy: { label: "Authorized redirect URI", value: redirectUri } }),
  },
  { text: "Copy the client ID and client secret Google shows, and paste them here." },
];

const slackSteps = (redirectUri: string | undefined): Array<IntegrationSetupStep> => [
  {
    text: "Copy this app manifest. It already contains your Cogenly sign-in address.",
    ...(redirectUri === undefined
      ? {}
      : { copy: { label: "App manifest", value: slackAppManifest(redirectUri) } }),
  },
  {
    text: "Create a new Slack app From a manifest, pick your workspace, and paste the manifest.",
    url: "https://api.slack.com/apps?new_app=1",
  },
  { text: "On the app's Agents & AI Apps page, turn on Model Context Protocol." },
  {
    text: "On Basic Information, copy the Client ID and Client Secret, and paste them here.",
  },
];

const githubSteps = (redirectUri: string | undefined): Array<IntegrationSetupStep> => [
  {
    text: "Register a new OAuth app on GitHub. Any name and homepage URL will do.",
    url: "https://github.com/settings/applications/new",
  },
  {
    text: "Set the Authorization callback URL to this address.",
    ...(redirectUri === undefined
      ? {}
      : { copy: { label: "Authorization callback URL", value: redirectUri } }),
  },
  { text: "Generate a client secret, then paste the Client ID and the secret here." },
];

const appClient = (input: SetupInput, problem?: string): IntegrationSetupAction | undefined => {
  const entry = input.entry;
  if (entry === undefined) {
    if (input.integration?.auth?.type !== "oauth") return undefined;
    const { account } = titleOf(input);
    return {
      type: "oauth_client",
      ...baseOf(input),
      title: `Set up ${account}'s OAuth client`,
      message:
        problem ??
        `${account} needs an app of your own. Create an OAuth app with the service, then paste its client ID and secret here.`,
      steps: [
        { text: "Create an OAuth app in this service's developer settings." },
        {
          text: "Add this exact redirect URI to the app.",
          ...(input.redirectUri === undefined
            ? {}
            : { copy: { label: "Authorized redirect URI", value: input.redirectUri } }),
        },
        { text: "Copy the app's client ID and secret, and paste them here." },
      ],
    };
  }
  const { account } = titleOf(input);
  const base = { type: "oauth_client" as const, ...baseOf(input) };
  const synced =
    input.syncedFrom === undefined
      ? undefined
      : `${account} was connected on ${input.syncedFrom.machineLabel}. This machine needs the app's client ID and secret too; paste them here, then sign in.`;
  const insecure =
    input.redirectUri !== undefined && input.redirectUri.startsWith("http:")
      ? " Slack only accepts an https address, so open Cogenly from its HTTPS address while you do this."
      : "";
  switch (entry.id) {
    case "google-workspace":
      return {
        ...base,
        title: "Set up your Google OAuth client",
        message:
          problem ??
          "Google needs an OAuth client of your own. It takes about five minutes in Google Cloud; then paste its client ID and secret here. Every Google account you connect uses it.",
        steps: googleSteps(input.redirectUri),
      };
    case "slack":
      return {
        ...base,
        title: synced === undefined ? "Create your Slack app" : "Sign in on this machine",
        message:
          synced ??
          `${problem ?? "Slack only lets you sign in through an app you create. Make one from Cogenly's manifest, then paste its client ID and secret here."}${insecure}`,
        steps: slackSteps(input.redirectUri),
      };
    case "github":
      return {
        ...base,
        title: synced === undefined ? "Register a GitHub OAuth app" : "Sign in on this machine",
        message:
          synced ??
          problem ??
          "Signing in to GitHub needs an OAuth app you register. A personal access token works too.",
        steps: githubSteps(input.redirectUri),
      };
    default:
      return undefined;
  }
};

const apiKey = (input: SetupInput, problem?: string): IntegrationSetupAction | undefined => {
  const entry = input.entry;
  if (entry?.kind !== "remote") return undefined;
  const mode = entry.auth.find((auth) => auth.kind === "api_key");
  if (mode === undefined) return undefined;
  const help = API_KEY_HELP[entry.id];
  return {
    type: "api_key",
    ...baseOf(input),
    title: `Add your ${entry.name} ${mode.label.replace(/^[A-Z][a-z]/, (start) => start.toLowerCase())}`,
    message: problem ?? help?.how ?? `Paste your ${entry.name} ${mode.label} here.`,
    label: mode.label,
    ...(help === undefined ? {} : { url: help.url }),
  };
};

const fix = (
  input: SetupInput,
  title: string,
  message: string,
  button: "edit" | "enable" = "edit",
): IntegrationSetupAction => ({ type: "fix", ...baseOf(input), title, message, button });

const retry = (
  input: SetupInput,
  title: string,
  fallback: string,
  button: "test" | "sign_in" = "test",
): IntegrationSetupAction => ({
  type: "retry",
  ...baseOf(input),
  title,
  message: input.message ?? fallback,
  button,
});

const usesClientSecret = (input: SetupInput) => input.integration?.auth?.clientId !== undefined;
const usesHeaderCredential = (input: SetupInput) =>
  Object.values(input.integration?.headers ?? {}).some((value) => value.includes("{{credential:"));

/** A vault reference the integration uses is missing, or not allowed for its server. */
const credentialProblem = (input: SetupInput, notAllowed: boolean): IntegrationSetupAction => {
  const { service } = titleOf(input);
  if (input.entry?.kind === "local-preset")
    return appClient(
      input,
      notAllowed
        ? `The saved Google OAuth client isn't allowed to be sent to ${GOOGLE_HOST}. Paste its client ID and secret again to fix that.`
        : "The saved Google OAuth client can't be read. Paste its client ID and secret again.",
    )!;
  if (usesClientSecret(input)) {
    const action = appClient(
      input,
      notAllowed
        ? "The app's saved client secret isn't allowed for this service. Paste the client ID and secret again to fix that."
        : "The app's client secret is missing from the vault. Paste the client ID and secret again.",
    );
    if (action !== undefined) return action;
  }
  if (usesHeaderCredential(input)) {
    const action = apiKey(
      input,
      notAllowed
        ? "The saved key isn't allowed for this service. Paste it again to fix that."
        : "The saved key is missing from the vault. Paste it again.",
    );
    if (action !== undefined) return action;
  }
  return notAllowed
    ? fix(
        input,
        "A saved secret isn't allowed here",
        `A vault item ${service} uses isn't allowed for its server. Add the server to the item's allowed domains, or save the integration again to approve it.`,
      )
    : fix(
        input,
        "A saved secret is missing",
        `A vault item ${service} uses is missing. Choose the right item for each header, then save.`,
      );
};

/** The next action, or undefined when nothing stands in the way. */
export const setupActionFor = (input: SetupInput): IntegrationSetupAction | undefined => {
  const { service } = titleOf(input);
  switch (input.reason) {
    case "google_client_missing":
      return appClient(input);
    case "local_runtime_missing": {
      const runtime = input.runtime ?? { canInstall: false, command: "brew install uv" };
      return {
        type: "install_runtime",
        ...baseOf(input),
        title: "Install uv",
        message: runtime.canInstall
          ? `${service} runs with uv, a small Python tool runner, which isn't installed on the machine running Cogenly. Cogenly can install it for you.`
          : `${service} runs with uv, a small Python tool runner, which isn't installed on the machine running Cogenly. Install it with ${runtime.command}, then try again.`,
        runtime: "uv",
        canInstall: runtime.canInstall,
        command: runtime.command,
      };
    }
    case "client_id_required":
      return (
        appClient(input) ??
        fix(
          input,
          "This server needs your own app",
          `${service} doesn't let Cogenly register itself. Create an app with the service, then add its client ID and secret in Edit.`,
        )
      );
    case "credential_unresolved":
      return credentialProblem(input, false);
    case "credential_not_allowed":
      return credentialProblem(input, true);
    case "sign_in_required":
      return input.syncedFrom !== undefined && usesClientSecret(input)
        ? (appClient(input) ?? signIn(input))
        : signIn(input);
    case "upstream_unreachable":
    case "upstream_timeout":
      return retry(
        input,
        `Couldn't reach ${service}`,
        `${service} didn't answer. Check your connection, then try again.`,
        input.status === "needs_sign_in" ? "sign_in" : "test",
      );
    case "upstream_error":
      return retry(
        input,
        `${service} returned an error`,
        `${service} answered with an error. Try again in a moment.`,
        input.status === "needs_sign_in" ? "sign_in" : "test",
      );
    case "approval_required":
      return fix(
        input,
        "Needs your approval",
        "This change widens access or moves a saved secret to a new server, so the owner makes it in Settings.",
      );
    case "disabled":
      return fix(input, `${service} is turned off`, "Turn it on to let agents use it.", "enable");
    case "invalid_request":
      return input.status === "needs_sign_in" || input.status === "error"
        ? fix(
            input,
            `${service} needs a change`,
            input.message ?? "Its settings aren't valid. Check the address and headers in Edit.",
          )
        : undefined;
    case "storage":
    case "not_found":
    case "conflict":
    case undefined:
      break;
  }
  if (input.status === "needs_sign_in")
    return input.syncedFrom !== undefined && usesClientSecret(input)
      ? (appClient(input) ?? signIn(input))
      : signIn(input);
  if (input.status === "error")
    return retry(
      input,
      `${service} isn't working`,
      `The last request to ${service} failed. Try again.`,
    );
  return undefined;
};

/**
 * What connecting a catalog entry needs first, before any account exists:
 * an API key or the owner's own app for that auth mode.
 */
export const catalogSetupFor = (input: {
  readonly entry: IntegrationCatalogEntry;
  readonly mode: IntegrationCatalogAuthKind;
  readonly redirectUri?: string | undefined;
}): IntegrationSetupAction | undefined =>
  input.mode === "api_key"
    ? apiKey({ entry: input.entry })
    : input.mode === "oauth_app"
      ? appClient({ entry: input.entry, redirectUri: input.redirectUri })
      : undefined;

/**
 * `Settings → Integrations`, opened on one account (integration id) or
 * catalog entry (catalog id) when `target` is set. Relative when the
 * request's origin is unknown.
 */
export const settingsSetupUrl = (origin: string | undefined, target?: string): string => {
  const base = `${(origin === undefined ? null : URL.parse(origin))?.origin ?? ""}/settings/integrations`;
  return target === undefined ? base : `${base}?setup=${encodeURIComponent(target)}`;
};

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

/** Vault item names for an account's secrets; one per account, so accounts never share one by accident. */
export const secretItemName = (
  base: string,
  kind: "api-key" | "client-secret",
  accountLabel?: string | undefined,
) => {
  const label = accountLabel === undefined ? "" : slug(accountLabel);
  return `${base}${label === "" ? "" : `-${label}`}-${kind}`;
};

/** Agents perform setup and ask only for actions requiring the account owner. */
export const agentNextStep = (
  action: IntegrationSetupAction,
  context: {
    readonly settingsUrl: string;
    readonly entry?: IntegrationCatalogEntry | undefined;
    readonly name?: string | undefined;
    readonly accountLabel?: string | undefined;
  },
): string => {
  const retry =
    context.name === undefined
      ? `Retry integration_add${context.entry === undefined ? "" : ` with catalogId ${context.entry.id}`}.`
      : `Retry integration_update with name ${context.name}.`;
  const copies =
    action.type === "oauth_client"
      ? action.steps
          .flatMap((step) =>
            step.copy === undefined ? [] : [`${step.copy.label}: ${step.copy.value}`],
          )
          .join("\n")
      : "";
  return `${integrationSetupGuide(context.entry?.id ?? "custom").instructions}\n\nCurrent requirement: ${action.title}. ${copies}\n${retry}`;
};

/** A connect or update result for an agent: its setup action, in words and as a Settings link. */
export const withAgentNextStep = (
  result: IntegrationConnectResult,
  context: { readonly origin: string | undefined; readonly accountLabel?: string | undefined },
): IntegrationAgentResult => {
  const setup = result.setup;
  if (setup === undefined) return result;
  const settingsUrl = settingsSetupUrl(
    context.origin,
    result.integration?.id ?? setup.integrationId ?? setup.catalogId,
  );
  return {
    ...result,
    settingsUrl,
    nextStep: agentNextStep(setup, {
      settingsUrl,
      entry: setup.catalogId === undefined ? undefined : integrationCatalogEntry(setup.catalogId),
      name: result.integration?.name,
      accountLabel: result.integration?.accountLabel ?? context.accountLabel,
    }),
  };
};

/** One `integrations_list` row for an agent, with the next step when it isn't usable. */
export const agentSummary = (summary: IntegrationSummary, origin: string | undefined) => {
  if (summary.setup === undefined) return summary;
  const settingsUrl = settingsSetupUrl(origin, summary.integration.id);
  return {
    ...summary,
    settingsUrl,
    nextStep: agentNextStep(summary.setup, {
      settingsUrl,
      entry: integrationCatalogEntryFor(summary.integration),
      name: summary.integration.name,
      accountLabel: summary.integration.accountLabel,
    }),
  };
};

const PLAIN_FAILURES: Partial<Record<IntegrationError["reason"], string>> = {
  not_found: "No connected integration with that name is available in this project.",
  conflict: "An integration with that name already exists.",
  storage: "The integration request could not be completed.",
};

/**
 * An integration failure as an agent reads it: the same action Settings
 * shows, in words. `transient` reasons are the server's or the service's
 * fault rather than the request's.
 */
export const agentFailureMessage = (
  error: { readonly reason: IntegrationError["reason"]; readonly cause?: unknown },
  origin: string | undefined,
): { readonly message: string; readonly transient: boolean } => {
  const transient =
    error.reason === "storage" ||
    error.reason === "upstream_error" ||
    error.reason === "upstream_timeout" ||
    error.reason === "upstream_unreachable";
  const plain = PLAIN_FAILURES[error.reason];
  if (plain !== undefined) return { message: plain, transient };
  const entry =
    error.reason === "google_client_missing" || error.reason === "local_runtime_missing"
      ? integrationCatalogEntry("google-workspace")
      : undefined;
  const action = setupActionFor({
    entry,
    status: "error",
    reason: error.reason,
    ...(error.reason === "upstream_error" && typeof error.cause === "string"
      ? { message: error.cause }
      : {}),
  });
  if (action === undefined) return { message: PLAIN_FAILURES.storage!, transient };
  return {
    message: agentNextStep(action, {
      settingsUrl: settingsSetupUrl(origin, entry?.id),
      entry,
    }),
    transient,
  };
};

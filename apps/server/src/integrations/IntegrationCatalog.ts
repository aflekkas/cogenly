import {
  INTEGRATION_CATALOG,
  IntegrationName,
  integrationCatalogEntry,
  integrationCatalogEntryFor,
  type Integration,
  type IntegrationAddInput,
  type IntegrationAddToolInput,
  type IntegrationCatalogAuthKind,
  type IntegrationCatalogConnectInput,
  type IntegrationCatalogEntry,
  type IntegrationCatalogId,
} from "@cogenly/contracts";
import { isLoopbackHost } from "@cogenly/shared/preview";

import { parseCredentialRef } from "./IntegrationCredentials.ts";
import { secretItemName } from "./IntegrationSetup.ts";

/**
 * Turns a catalog connect request into the integration it creates, or the
 * next step the caller has to take first. Pure, so the gateway, the MCP tool
 * and a persistent agent's approval proposal resolve the same definition.
 */
export type CatalogResolution =
  | { readonly _tag: "ready"; readonly input: IntegrationAddInput; readonly signsIn: boolean }
  /**
   * `message` tells an agent what to do next, e.g. store a secret. `mode` is
   * the auth mode whose inputs are missing, which Settings turns into a setup action.
   */
  | {
      readonly _tag: "needs";
      readonly message: string;
      readonly mode?: IntegrationCatalogAuthKind;
    };

/** Exactly one `{{credential:<item>.<field>}}`, as the gateway accepts a client secret. */
const isCredentialReference = (value: string | undefined) => {
  const match = /^\{\{credential:([^}]*)\}\}$/.exec(value?.trim() ?? "");
  return match !== null && parseCredentialRef(match[1]!.trim()) !== undefined;
};

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

/** `linear`, then `linear-2`: an unused name for one more account. */
const uniqueName = (base: string, taken: ReadonlySet<string>) => {
  if (!taken.has(base)) return IntegrationName.make(base);
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return IntegrationName.make(candidate);
  }
};

/**
 * The name connecting `entry` gives a new account: `linear`, `linear-work`,
 * `google-personal`, with a number when it is taken. Settings names the
 * account's vault items after it before the account exists.
 */
export const catalogIntegrationName = (
  entry: IntegrationCatalogEntry,
  accountLabel: string | undefined,
  existingNames: ReadonlySet<string>,
) =>
  entry.kind === "local-preset"
    ? uniqueName(`google-${slug(accountLabel ?? "") || "account"}`, existingNames)
    : uniqueName(
        accountLabel === undefined ? entry.id : `${entry.id}-${slug(accountLabel) || "account"}`,
        existingNames,
      );

/**
 * Google's redirect URI is registered on one origin. A browser's or agent's
 * public origin is a good guess; loopback is left to the server's configured
 * default, which matches the `localhost` URI the docs ask users to register.
 */
const publicOrigin = (origin: string | undefined) => {
  const parsed = origin === undefined ? null : URL.parse(origin);
  return parsed === null ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    isLoopbackHost(parsed.hostname)
    ? undefined
    : parsed.origin;
};

/** Collect a secret privately into the vault, then reference it. */
const storeHint = (item: string, host: string, as: string) =>
  `Collect it with request_secret and saveToVault: {name: "${item}", type: "api_key", domains: ["${host}"]} (never in chat), then pass ${as}: "{{credential:${item}.value}}".`;

/** What an agent must collect for one auth mode, as one instruction. */
const inputsHelp = (
  entry: Extract<IntegrationCatalogEntry, { kind: "remote" }>,
  mode: IntegrationCatalogAuthKind,
  accountLabel: string | undefined,
) => {
  const docs = `Read integration_setup_guide with service "${entry.id}" and perform setup yourself.`;
  if (mode === "api_key") {
    const label = entry.auth.find((auth) => auth.kind === mode)?.label ?? "API key";
    const host = new URL(entry.url).hostname;
    return `${entry.name} needs the user's ${label}. ${storeHint(secretItemName(entry.id, "api-key", accountLabel), host, "apiKey")} ${docs}`;
  }
  const host = entry.tokenHost ?? new URL(entry.url).hostname;
  return `${entry.name} needs an OAuth app the user creates with ${entry.name}. Ask for its client ID and pass it as clientId; for its client secret: ${storeHint(secretItemName(entry.id, "client-secret", accountLabel), host, "clientSecret")} ${docs}`;
};

/**
 * Catalog ids an agent could still connect, as the per-turn integrations line
 * names them: every connectable entry without an integration yet.
 */
export const availableToConnect = (
  connected: ReadonlyArray<Pick<Integration, "transport" | "url" | "local">>,
): Array<string> => {
  const used = new Set(connected.map((integration) => integrationCatalogEntryFor(integration)?.id));
  return INTEGRATION_CATALOG.filter((entry) => !used.has(entry.id)).map((entry) =>
    entry.kind === "local-preset" ? `${entry.id} (Gmail, Calendar, Drive)` : entry.id,
  );
};

/**
 * The flat `integration_add` arguments as a catalog request, for the MCP tool
 * and for a persistent agent's proposal alike.
 */
export const catalogRequest = (
  input: IntegrationAddToolInput & { readonly catalogId: IntegrationCatalogId },
): IntegrationCatalogConnectInput => ({
  catalogId: input.catalogId,
  ...(input.accountLabel?.trim() ? { accountLabel: input.accountLabel.trim() } : {}),
  inputs: {
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
    ...(input.clientSecret === undefined ? {} : { clientSecret: input.clientSecret }),
    ...(input.callbackOrigin === undefined ? {} : { callbackOrigin: input.callbackOrigin }),
  },
  ...(input.scope === undefined ? {} : { scope: input.scope }),
});

export const resolveCatalogConnect = (
  request: IntegrationCatalogConnectInput,
  context: {
    /** Names already used, so another account gets its own. */
    readonly existingNames: ReadonlySet<string>;
    /** The origin the request reached; a public one becomes Google's callback origin. */
    readonly requestOrigin: string | undefined;
    readonly fromAgent?: boolean | undefined;
  },
): CatalogResolution => {
  const entry = integrationCatalogEntry(request.catalogId);
  if (entry === undefined) return { _tag: "needs", message: "That catalog entry doesn't exist." };
  const inputs = request.inputs ?? {};
  const accountLabel = request.accountLabel?.trim() || undefined;
  const scope = request.scope ?? { type: "all" as const };

  if (entry.kind === "local-preset") {
    if (accountLabel === undefined)
      return {
        _tag: "needs",
        message:
          'Pass accountLabel to name this Google account, e.g. "personal" or "work"; each Google account is its own integration.',
      };
    const callbackOrigin = inputs.callbackOrigin ?? publicOrigin(context.requestOrigin);
    return {
      _tag: "ready",
      signsIn: true,
      input: {
        preset: entry.preset,
        accountLabel,
        name: catalogIntegrationName(entry, accountLabel, context.existingNames),
        ...(callbackOrigin === undefined ? {} : { callbackOrigin }),
        scope,
      },
    };
  }

  const mode =
    inputs.auth ??
    (inputs.apiKey !== undefined
      ? "api_key"
      : inputs.clientId !== undefined || inputs.clientSecret !== undefined
        ? "oauth_app"
        : entry.auth.find((auth) => auth.kind === "oauth")?.kind);
  if (mode === undefined)
    return {
      _tag: "needs",
      mode: entry.auth[0].kind,
      message: inputsHelp(entry, entry.auth[0].kind, accountLabel),
    };
  if (!entry.auth.some((auth) => auth.kind === mode))
    return {
      _tag: "needs",
      message: `${entry.name} connects with: ${entry.auth.map((auth) => auth.label).join(", ")}.${entry.auth[0].kind === "oauth" ? " Omit apiKey, clientId and clientSecret to sign in." : ` ${inputsHelp(entry, entry.auth[0].kind, accountLabel)}`}`,
    };
  if (mode === "api_key" && !isCredentialReference(inputs.apiKey))
    return { _tag: "needs", mode, message: inputsHelp(entry, mode, accountLabel) };
  if (
    mode === "oauth_app" &&
    (inputs.clientId === undefined || !isCredentialReference(inputs.clientSecret))
  )
    return { _tag: "needs", mode, message: inputsHelp(entry, mode, accountLabel) };

  const oauthScope = entry.oauthScope === undefined ? {} : { scope: entry.oauthScope };
  return {
    _tag: "ready",
    signsIn: mode !== "api_key",
    input: {
      name: catalogIntegrationName(entry, accountLabel, context.existingNames),
      displayName: entry.name,
      transport: "http",
      url: entry.url,
      headers: mode === "api_key" ? { Authorization: `Bearer ${inputs.apiKey!.trim()}` } : {},
      scope,
      hint: "",
      ...(accountLabel === undefined ? {} : { accountLabel }),
      ...(mode === "oauth"
        ? { auth: { type: "oauth" as const, ...oauthScope } }
        : mode === "oauth_app"
          ? {
              auth: {
                type: "oauth" as const,
                clientId: inputs.clientId!,
                clientSecret: inputs.clientSecret!.trim(),
                ...oauthScope,
              },
            }
          : {}),
    },
  };
};

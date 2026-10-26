import type { VaultPolicy } from "@cogenly/contracts";

/** Normalizes a page host: lowercase, no port, no trailing dot. Empty for unparsable input. */
export const normalizeHost = (hostOrUrl: string): string => {
  const trimmed = hostOrUrl.trim().toLowerCase();
  if (!trimmed) return "";
  try {
    const host = trimmed.includes("://") ? new URL(trimmed).hostname : trimmed.split("/")[0]!;
    return host.replace(/:\d+$/, "").replace(/\.$/, "");
  } catch {
    return "";
  }
};

/** Exact host or a subdomain of an allowed domain. Never a suffix lookalike. */
export const hostMatchesDomain = (hostOrUrl: string, allowedDomain: string): boolean => {
  const host = normalizeHost(hostOrUrl);
  const domain = normalizeHost(allowedDomain);
  if (!host || !domain) return false;
  return host === domain || host.endsWith(`.${domain}`);
};

export const hostMatchesAnyDomain = (
  hostOrUrl: string,
  allowedDomains: ReadonlyArray<string>,
): boolean => allowedDomains.some((domain) => hostMatchesDomain(hostOrUrl, domain));

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Whether a vault secret may be typed into a page at `pageUrl`. Secrets only
 * travel over https, except a loopback dev origin that the item's allowed
 * sites list explicitly with its scheme (e.g. `http://localhost:3000`): a
 * bare `localhost` entry does not opt an http page in.
 */
export type VaultFillOriginDenial = "invalid-url" | "requires-https" | "loopback-not-listed";
export const vaultFillOriginDenial = (
  pageUrl: string,
  allowedSites: ReadonlyArray<string>,
): VaultFillOriginDenial | null => {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return "invalid-url";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) return "requires-https";
  const explicitlyAllowed = allowedSites.some((site) => {
    try {
      return new URL(site).origin === url.origin;
    } catch {
      return false;
    }
  });
  return explicitlyAllowed ? null : "loopback-not-listed";
};
export const vaultFillOriginMessage = (denial: VaultFillOriginDenial): string =>
  denial === "invalid-url"
    ? "vault_fill needs a page with a valid URL."
    : denial === "requires-https"
      ? "vault_fill only fills secrets on https pages."
      : "vault_fill only fills secrets on https pages, or on a loopback origin listed with its http scheme in the item's allowed sites.";

/** One of the item's allowed sites, or a site where the owner approved a fill of it. */
export const isApprovedSite = (
  domain: string | null | undefined,
  item: { readonly allowedDomains: ReadonlyArray<string>; readonly policy: VaultPolicy },
): boolean =>
  !!domain &&
  hostMatchesAnyDomain(domain, [...item.allowedDomains, ...(item.policy.approvedDomains ?? [])]);

export type VaultUseCaller =
  | { readonly kind: "human" }
  | { readonly kind: "server" }
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "thread"; readonly threadId: string };

export type VaultPolicyDecision = "allow" | "ask" | "deny";

/**
 * Human and server-internal callers are allowed. MCP threads and persistent
 * agents require `allow` for their identity and the destination domain. Empty
 * identity lists mean any thread or agent; `deny` refuses them; everything
 * else asks the owner. Whether the page is one of the item's allowed sites is
 * checked separately (see `isApprovedSite`).
 */
export const evaluateVaultPolicy = (input: {
  readonly policy: VaultPolicy;
  readonly caller: VaultUseCaller;
  readonly domain?: string | null | undefined;
}): VaultPolicyDecision => {
  if (input.caller.kind === "human" || input.caller.kind === "server") return "allow";
  if (input.policy.mode === "deny") return "deny";
  if (input.policy.mode !== "allow") return "ask";
  const caller = input.caller;
  const threads = input.policy.allowedThreadIds ?? [];
  const restricted = input.policy.allowedAgentIds.length > 0 || threads.length > 0;
  if (
    restricted &&
    (caller.kind === "agent"
      ? !input.policy.allowedAgentIds.some((id) => id === caller.agentId)
      : !threads.some((id) => id === caller.threadId))
  )
    return "ask";
  if (input.policy.allowedDomains.length > 0) {
    if (!input.domain || !hostMatchesAnyDomain(input.domain, input.policy.allowedDomains))
      return "ask";
  }
  return "allow";
};

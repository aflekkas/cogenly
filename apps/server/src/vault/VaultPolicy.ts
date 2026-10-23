import type { VaultPolicy } from "@t3tools/contracts";

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

export type VaultUseCaller =
  | { readonly kind: "human" }
  | { readonly kind: "server" }
  | { readonly kind: "agent"; readonly agentId: string };

export type VaultPolicyDecision = "allow" | "ask" | "deny";

/**
 * Owner/human-initiated turns and server-internal callers are allowed. An
 * agent is allowed only when the item policy says `allow` for that agent
 * (an empty agent list means any agent) and, when the policy lists domains,
 * for this domain. Everything else asks the owner.
 */
export const evaluateVaultPolicy = (input: {
  readonly policy: VaultPolicy;
  readonly caller: VaultUseCaller;
  readonly domain?: string | null | undefined;
}): VaultPolicyDecision => {
  if (input.caller.kind !== "agent") return "allow";
  const agentId = input.caller.agentId;
  if (input.policy.mode !== "allow") return "ask";
  if (
    input.policy.allowedAgentIds.length > 0 &&
    !input.policy.allowedAgentIds.some((id) => id === agentId)
  )
    return "ask";
  if (input.policy.allowedDomains.length > 0) {
    if (!input.domain || !hostMatchesAnyDomain(input.domain, input.policy.allowedDomains))
      return "ask";
  }
  return "allow";
};

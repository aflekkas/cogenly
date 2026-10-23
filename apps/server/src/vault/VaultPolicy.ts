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

/**
 * Who is asking. Every MCP caller is an `agent` (a persistent agent's thread)
 * or a `thread` (any other agent thread); only server code is `server`.
 */
export type VaultUseCaller =
  | { readonly kind: "server" }
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "thread"; readonly threadId: string };

export type VaultPolicyDecision = "allow" | "ask" | "deny";

/**
 * Server-internal callers are allowed. An agent or thread is allowed only
 * when the item policy says `allow` for it (an empty agent list means any
 * agent or thread; a non-empty one names persistent agents) and, when the
 * policy lists domains, for this domain. Everything else asks the owner.
 */
export const evaluateVaultPolicy = (input: {
  readonly policy: VaultPolicy;
  readonly caller: VaultUseCaller;
  readonly domain?: string | null | undefined;
}): VaultPolicyDecision => {
  if (input.caller.kind === "server") return "allow";
  const agentId = input.caller.kind === "agent" ? input.caller.agentId : null;
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
